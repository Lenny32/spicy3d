// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentRebuilds, type IDocument, KernelRecovery, KernelState } from "@spicy3d/core";
import type { Tool, ToolCallContext } from "../llm/types";
import { handleRunProgram, type ProgramProgress, runProgramParameters } from "./capabilityEngine";
import { cornerJobDefinitions, executeCornerJob } from "./cornerJobs";
import { getDocument } from "./documentContext";

type JobState = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
type Job = {
    id: string;
    caller: string;
    document: IDocument;
    state: JobState;
    progress: ProgramProgress;
    controller: AbortController;
    result?: unknown;
    error?: string;
    finishedAt?: number;
    deadline: ReturnType<typeof setTimeout>;
};

const MAX_JOBS = 16;
const MAX_CALLER_ACTIVE = 4;
const RETENTION_MS = 10 * 60_000;
const MAX_RESULT_BYTES = 1_048_576;
const jobTools = new WeakSet<Tool>();

/** Identity-based bypass: naming a plugin tool like a built-in never grants it queue access. */
export function isProgramJobTool(tool: Tool): boolean {
    return jobTools.has(tool);
}

export type ProgramJobExecutor = (
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    progress: ((value: ProgramProgress) => void) | undefined,
    document: IDocument,
) => Promise<string>;

export class ProgramJobs {
    private readonly jobs = new Map<string, Job>();

    constructor(
        private readonly execute: ProgramJobExecutor = handleRunProgram,
        private readonly now = Date.now,
    ) {}

    start(args: Record<string, unknown>, context?: ToolCallContext): unknown {
        const document = getDocument();
        if (!document) throw new Error("No active document");
        if (KernelState.current.message) throw new Error(KernelState.current.message);
        if (!context?.caller || !context.scheduleMutation)
            throw new Error("Background programs require an MCP session and its shared mutation queue");
        const ops = args["ops"];
        if (!Array.isArray(ops) || ops.length === 0 || ops.length > 256)
            throw new Error("A background program requires 1–256 operations");
        const timeoutMs = args["timeoutMs"] ?? 120_000;
        if (
            typeof timeoutMs !== "number" ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 600_000
        )
            throw new Error("timeoutMs must be finite and within 1–600000 milliseconds");
        const input = structuredClone({ ops });
        if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_RESULT_BYTES)
            throw new Error("Background program arguments exceed 1 MiB");
        this.prune();
        const active = [...this.jobs.values()].filter((job) => job.finishedAt === undefined);
        if (active.filter((job) => job.caller === context.caller).length >= MAX_CALLER_ACTIVE)
            throw new Error("This session already has four active modeling jobs");
        if (this.jobs.size >= MAX_JOBS) {
            const old = [...this.jobs.values()].find((job) => job.finishedAt !== undefined);
            if (old) this.jobs.delete(old.id);
            else throw new Error("The page already has sixteen active modeling jobs");
        }
        const job: Job = {
            id: crypto.randomUUID(),
            caller: context.caller,
            document,
            state: "queued",
            progress: { completed: 0, total: ops.length },
            controller: new AbortController(),
            deadline: setTimeout(() => this.cancelJob(job, "Modeling job deadline exceeded"), timeoutMs),
        };
        this.jobs.set(job.id, job);
        void context
            .scheduleMutation(async () => {
                if (job.controller.signal.aborted) return;
                job.state = "running";
                try {
                    if (getDocument() !== document)
                        throw new Error(
                            "The active document changed before this job started; no edits were made",
                        );
                    if (KernelState.current.message) throw new Error(KernelState.current.message);
                    const result = await this.execute(
                        input,
                        job.controller.signal,
                        (value) => {
                            job.progress = { ...value };
                        },
                        document,
                    );
                    if (new TextEncoder().encode(result).length > MAX_RESULT_BYTES) {
                        job.state = "completed";
                        job.error =
                            "Program committed, but its completion result exceeds the 1 MiB job limit; inspect the document";
                        return;
                    }
                    const payload: unknown = JSON.parse(result);
                    if (payload && typeof payload === "object" && "error" in payload)
                        throw new Error(String(payload.error));
                    job.result = payload;
                    job.error = undefined;
                    job.state = "completed";
                } catch (error) {
                    job.state = job.controller.signal.aborted ? "cancelled" : "failed";
                    job.error ??= error instanceof Error ? error.message : String(error);
                } finally {
                    clearTimeout(job.deadline);
                    job.finishedAt = this.now();
                }
            })
            .catch((error: unknown) => {
                clearTimeout(job.deadline);
                job.state = "failed";
                job.error = error instanceof Error ? error.message : String(error);
                job.finishedAt = this.now();
            });
        return this.snapshot(job);
    }

    read(args: Record<string, unknown>, context?: ToolCallContext): unknown {
        return this.snapshot(this.find(args, context));
    }

    cancel(args: Record<string, unknown>, context?: ToolCallContext): unknown {
        const job = this.find(args, context);
        this.cancelJob(job, "Cancelled by the caller");
        return this.snapshot(job);
    }

    /** Recovery must not await queued mutations behind its own FIFO slot. */
    cancelAll(reason: string): void {
        for (const job of this.jobs.values()) this.cancelJob(job, reason);
    }

    forget(caller: string): void {
        for (const job of this.jobs.values()) {
            if (job.caller !== caller) continue;
            this.cancelJob(job, "The MCP session ended");
            this.jobs.delete(job.id);
        }
    }

    private cancelJob(job: Job, reason: string): void {
        if (job.finishedAt !== undefined || job.controller.signal.aborted) return;
        job.error = reason;
        const queued = job.state === "queued";
        job.state = queued ? "cancelled" : "cancelling";
        job.controller.abort();
        if (queued) {
            clearTimeout(job.deadline);
            job.finishedAt = this.now();
        }
    }

    private find(args: Record<string, unknown>, context?: ToolCallContext): Job {
        this.prune();
        const job = typeof args["jobId"] === "string" ? this.jobs.get(args["jobId"]) : undefined;
        if (!job || !context?.caller || job.caller !== context.caller)
            throw new Error("Modeling job not found for this session");
        return job;
    }

    private prune(): void {
        for (const job of this.jobs.values())
            if (job.finishedAt !== undefined && this.now() - job.finishedAt >= RETENTION_MS)
                this.jobs.delete(job.id);
    }

    private snapshot(job: Job): unknown {
        return {
            jobId: job.id,
            documentId: job.document.id,
            state: job.state,
            progress: { ...job.progress },
            result: job.result,
            error: job.error,
        };
    }
}

const PAGE_JOBS = new ProgramJobs();
const CORNER_JOBS = new ProgramJobs(executeCornerJob);
export const cancelAllProgramJobs = (reason: string): void => {
    PAGE_JOBS.cancelAll(reason);
    CORNER_JOBS.cancelAll(reason);
};
KernelRecovery.current.addQuiesce(() => cancelAllProgramJobs("Main kernel recovery cancelled modeling jobs"));
export const forgetProgramJobs = (caller: string): void => {
    PAGE_JOBS.forget(caller);
    CORNER_JOBS.forget(caller);
};

export function buildProgramJobTools(jobs = PAGE_JOBS): Tool[] {
    const idParameters = { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] };
    const tools: Tool[] = [
        {
            name: "start_program_job",
            description:
                "Queue a run_program in the page's shared mutation FIFO and immediately return a jobId. Poll get_program_job for live completed-operation counts and the completion result. Worker-eligible geometry remains responsive; synchronous query/creation operations retain their existing limits. Jobs belong to this MCP session and the active document, expire ten minutes after finishing, and cancel when the session ends. Default deadline 120s, maximum 600s; result limit 1 MiB. An oversized result reports completed with a reporting error, preserving committed edits. Load modeling-api for ops.",
            parameters: {
                ...runProgramParameters(),
                properties: {
                    ...(runProgramParameters()["properties"] as object),
                    timeoutMs: { type: "number", minimum: 1, maximum: 600_000 },
                },
            },
            handler: async (args, _signal, context) => JSON.stringify(jobs.start(args, context)),
        },
        {
            name: "get_program_job",
            description:
                "Read live queued/running/cancelling/completed/cancelled/failed state and operation progress without waiting for the mutation queue. Completed jobs include the run_program result; failures include their error. Only this session's jobs are visible.",
            parameters: idParameters,
            handler: async (args, _signal, context) => JSON.stringify(jobs.read(args, context)),
        },
        {
            name: "cancel_program_job",
            description:
                "Request cancellation without waiting for the mutation queue. Running jobs report cancelling until native termination and rollback finish, then cancelled; completed jobs remain completed.",
            parameters: idParameters,
            handler: async (args, _signal, context) => JSON.stringify(jobs.cancel(args, context)),
        },
        {
            name: "get_rebuild_status",
            description:
                "Read runtime background parametric rebuild status for the active document without geometry reads or queue waits. Returns pending job count and last yielded feature indexes where known; does not invent a percentage or start a rebuild. run_parametric retains its synchronous behavior.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const document = getDocument();
                return JSON.stringify(
                    document
                        ? { documentId: document.id, ...DocumentRebuilds.status(document) }
                        : { hasActiveDocument: false },
                );
            },
        },
    ];
    for (const tool of tools) jobTools.add(tool);
    return tools;
}

export function buildCornerJobTools(jobs = CORNER_JOBS): Tool[] {
    const tools = cornerJobDefinitions(jobs);
    for (const tool of tools) jobTools.add(tool);
    return tools;
}
