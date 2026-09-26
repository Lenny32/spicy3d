// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "./foundation/result";
import type { Serialized } from "./serialize";

/**
 * The serialized document envelope's format. Bump it — and register a migration from the previous
 * value plus a fixture under `packages/core/test/fixtures/documents/v<N>/` — whenever the shape of
 * the envelope or of any core `@serialize()` field changes.
 */
export const DOCUMENT_FORMAT_VERSION = 1;

/** The module name the envelope's own `formatVersion` is registered under. */
export const DOCUMENT_MODULE = "document";

/**
 * One step of a migration chain: turns a whole document envelope at version `from` into one at
 * `from + 1`. Must be pure and deterministic — no DOM, no WASM, no globals — so it runs in Node
 * (the server, the merge engine) exactly as in the page. The runner hands it a private copy with
 * `userData` taken out, and bumps the version fields itself.
 */
export type DocumentMigration = (data: Serialized) => Serialized;

export type DocumentFormatError =
    /** No integer `formatVersion` (e.g. a Chili3D file), or one older than any supported chain. */
    | { kind: "notSpicy3D" }
    /** Saved by a newer build — the running tab is stale. */
    | { kind: "newerFormat"; module: string; version: number; supported: number }
    /** A migration step threw or returned something that is not an object. */
    | { kind: "migrationFailed"; module: string; from: number; message: string };

export interface MigrationGap {
    module: string;
    from: number;
}

interface ModuleEntry {
    readonly current: number;
    readonly minimum: number;
    readonly migrations: Map<number, DocumentMigration>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Format versions of the document envelope and of every independently evolving payload (a
 * "module" — the parametric feature list, the sketch data, ...), with the chains that bring an
 * older document up to the running build.
 *
 * The envelope carries `formatVersion` for the document itself and `moduleVersions` for the
 * rest. A module missing from `moduleVersions` reads as its minimum version; entries for modules
 * this build does not know (a plugin that is not loaded) pass through untouched.
 */
export class MigrationRegistry {
    private readonly modules = new Map<string, ModuleEntry>();

    constructor(documentVersion = DOCUMENT_FORMAT_VERSION, documentMinimum = 1) {
        this.registerModule(DOCUMENT_MODULE, documentVersion, documentMinimum);
    }

    /** Declares a module's current version; `minimum` is the oldest version its chain starts from. */
    registerModule(module: string, current: number, minimum = 1): void {
        if (this.modules.has(module)) throw new Error(`Document module ${module} is already registered`);
        if (!Number.isInteger(current) || !Number.isInteger(minimum) || minimum > current) {
            throw new Error(`Invalid versions for document module ${module}: ${minimum}..${current}`);
        }
        this.modules.set(module, { current, minimum, migrations: new Map() });
    }

    /** Registers the step from `from` to `from + 1` of `module`'s chain. */
    registerMigration(module: string, from: number, migrate: DocumentMigration): void {
        const entry = this.modules.get(module);
        if (entry === undefined) throw new Error(`Document module ${module} is not registered`);
        if (!Number.isInteger(from) || from < entry.minimum || from >= entry.current) {
            throw new Error(
                `Migration ${module}@${from} is outside the chain ${entry.minimum}..${entry.current}`,
            );
        }
        if (entry.migrations.has(from)) throw new Error(`Migration ${module}@${from} is already registered`);
        entry.migrations.set(from, migrate);
    }

    currentVersion(module: string): number | undefined {
        return this.modules.get(module)?.current;
    }

    /** The current version of every registered module except the envelope itself. */
    moduleVersions(): Record<string, number> {
        const versions: Record<string, number> = {};
        for (const [module, entry] of this.modules) {
            if (module !== DOCUMENT_MODULE) versions[module] = entry.current;
        }
        return versions;
    }

    /** Every missing step between a module's minimum and current version; empty when all chains are whole. */
    findGaps(): MigrationGap[] {
        const gaps: MigrationGap[] = [];
        for (const [module, entry] of this.modules) {
            for (let from = entry.minimum; from < entry.current; from++) {
                if (!entry.migrations.has(from)) gaps.push({ module, from });
            }
        }
        return gaps;
    }

    /**
     * Brings a serialized document up to the running build's versions. The input is never
     * modified; the result is a fresh copy. Documents that must be compared (the merge engine's
     * base/ours/theirs) are each migrated first so they share one format.
     */
    migrate(data: unknown): Result<Serialized, DocumentFormatError> {
        const found = this.readVersions(data);
        if (!found.isOk) return Result.err(found.error);
        const versions = found.value;

        const { userData, ...rest } = structuredClone(data as Serialized);
        let current = rest as Serialized;
        for (const [module, entry] of this.modules) {
            for (let from = versions[module]; from < entry.current; from++) {
                const step = entry.migrations.get(from);
                if (step === undefined) {
                    return Result.err({
                        kind: "migrationFailed",
                        module,
                        from,
                        message: "missing migration",
                    });
                }
                try {
                    const next = step(current);
                    if (!isPlainObject(next)) throw new Error("migration did not return an object");
                    current = next as Serialized;
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    return Result.err({ kind: "migrationFailed", module, from, message });
                }
            }
        }

        const incoming = isPlainObject(rest["moduleVersions"]) ? rest["moduleVersions"] : {};
        current["formatVersion"] = this.modules.get(DOCUMENT_MODULE)!.current;
        current["moduleVersions"] = { ...incoming, ...this.moduleVersions() };
        if (userData !== undefined) current["userData"] = userData;
        return Result.ok(current);
    }

    private readVersions(data: unknown): Result<Record<string, number>, DocumentFormatError> {
        if (!isPlainObject(data)) return Result.err({ kind: "notSpicy3D" });
        const moduleVersions = data["moduleVersions"] ?? {};
        if (!isPlainObject(moduleVersions)) return Result.err({ kind: "notSpicy3D" });

        const versions: Record<string, number> = {};
        for (const [module, entry] of this.modules) {
            const raw = module === DOCUMENT_MODULE ? data["formatVersion"] : moduleVersions[module];
            const version = raw === undefined && module !== DOCUMENT_MODULE ? entry.minimum : raw;
            if (typeof version !== "number" || !Number.isInteger(version) || version < entry.minimum) {
                return Result.err({ kind: "notSpicy3D" });
            }
            if (version > entry.current) {
                return Result.err({ kind: "newerFormat", module, version, supported: entry.current });
            }
            versions[module] = version;
        }
        return Result.ok(versions);
    }
}

/** The registry `Document.load` migrates through; feature packages register their modules on it. */
export const DocumentMigrations = new MigrationRegistry();

export function registerDocumentModule(module: string, current: number, minimum = 1): void {
    DocumentMigrations.registerModule(module, current, minimum);
}

export function registerMigration(module: string, from: number, migrate: DocumentMigration): void {
    DocumentMigrations.registerMigration(module, from, migrate);
}

export function migrateDocument(data: unknown): Result<Serialized, DocumentFormatError> {
    return DocumentMigrations.migrate(data);
}
