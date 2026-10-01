// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelCrashedError, KernelState, Logger, Result } from "@spicy3d/core";

/**
 * The safety net under `cpp/src/guard.hpp`: a module built with `-fwasm-exceptions` catches OCCT
 * raises and answers an error, so an abort is left to real crashes (out of memory, a C++ bug); one
 * built with `-sDISABLE_EXCEPTION_CATCHING=1` aborts on any OCCT raise. Either way the call throws
 * `RuntimeError: Aborted(…)` with the C++ stack abandoned mid-operation. Often the module still
 * works afterwards (a fillet too large for its wall, and the next rebuild is fine), sometimes it is
 * left inconsistent and every later call traps ("table index is out of bounds"). The module cannot
 * be reused: every `OccShape` wraps a handle into that particular instance.
 *
 * So after an abort or a trap (`unreachable`, `table index is out of bounds`, …) a small probe runs
 * against the module: if the probe fails, the kernel is recorded as crashed in core's
 * `KernelState` with the first message, and from then on nothing re-enters the module: every call
 * fails at once with one stable message ({@link KernelCrashedError}). Retirement survives public
 * state resets; receiver and argument ownership prevents crossing into another instance.
 *
 * The glue's `FinalizationRegistry` may still call the dead module's destructors when handles are
 * garbage-collected after a crash: console noise only, and it cannot be intercepted from JS.
 */

/** Traps that may mean a corrupted module; the probe decides. */
const FATAL_TRAP =
    /unreachable|table index is out of bounds|null function or function signature mismatch|memory access out of bounds/i;

interface KernelGeneration {
    probe?: () => void;
    reason?: string;
    lastAbort?: string;
}
const moduleGenerations = new WeakMap<object, KernelGeneration>();
const prototypeGenerations = new WeakMap<object, KernelGeneration>();
let currentGeneration: KernelGeneration | undefined;
let preparationGeneration: KernelGeneration | undefined;
let probe: (() => void) | undefined;

/** An old native handle must never cross into another WebAssembly instance. */
export class KernelHandleOwnershipError extends Error {
    constructor() {
        super("Native handle belongs to a different kernel generation");
        this.name = "KernelHandleOwnershipError";
    }
}

/** Permanent retirement: resetting public crash state cannot revive this module. */
export function retireKernelModule(module: object, reason = "kernel generation retired"): void {
    const generation = moduleGenerations.get(module);
    if (generation && !generation.reason) generation.reason = reason;
}

/** Only the candidate instance may run during a synchronous recovery preparation turn. */
export function runKernelPreparation<T>(module: object, action: () => T): T {
    const generation = moduleGenerations.get(module);
    if (!generation || generation.reason)
        throw new Error("Recovery requires a healthy guarded kernel instance");
    const previous = preparationGeneration;
    try {
        preparationGeneration = generation;
        const result = action();
        if (result && typeof result === "object" && "then" in result)
            throw new Error("Kernel preparation must be synchronous");
        return result;
    } finally {
        preparationGeneration = previous;
    }
}

/** Callback bound to the instance that raised the abort, including after another instance was prepared. */
export function onKernelModuleAbort(module: object, what: unknown): void {
    const generation = moduleGenerations.get(module);
    if (generation === currentGeneration) onKernelAbort(what);
}

function ownerOf(value: unknown): KernelGeneration | undefined {
    if (!value || typeof value !== "object") return undefined;
    for (
        let prototype = Object.getPrototypeOf(value);
        prototype;
        prototype = Object.getPrototypeOf(prototype)
    ) {
        const owner = prototypeGenerations.get(prototype);
        if (owner) return owner;
    }
    return undefined;
}

function assertOwnership(value: unknown, generation: KernelGeneration): void {
    if (Array.isArray(value)) {
        for (const item of value) assertOwnership(item, generation);
        return;
    }
    const owner = ownerOf(value);
    if (owner && owner !== generation) throw new KernelHandleOwnershipError();
}

function assertGeneration(generation: KernelGeneration): void {
    if (generation.reason) throw new KernelCrashedError(generation.reason);
    if (crashed && preparationGeneration !== generation) {
        generation.reason = KernelState.current.reason ?? "unknown error";
        throw new KernelCrashedError(generation.reason);
    }
}
let probing = false;
/** The last abort seen, named in the reason of a crash that follows it. */
let lastAbort: string | undefined;
/**
 * `KernelState.current.isCrashed`, cached: it is read on every embind call, and the getter allocates
 * a key string each time. Kept in sync with the state (a test's `reset` clears it).
 */
let crashed = KernelState.current.isCrashed;
KernelState.current.onPropertyChanged(() => {
    crashed = KernelState.current.isCrashed;
});

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}

function isRuntimeError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === "RuntimeError" || error.constructor?.name === "RuntimeError")
    );
}

/** Emscripten's `Aborted(<what>)`, without its ". Build with -sASSERTIONS…" tail. */
function abortReason(error: unknown): string | undefined {
    const message = messageOf(error);
    if (!message.startsWith("Aborted(")) return undefined;
    const tail = message.indexOf(". Build with");
    return tail < 0 ? message : message.slice(0, tail);
}

function crash(reason: string): KernelCrashedError {
    if (KernelState.current.markCrashed(reason)) Logger.error(`geometry kernel crashed: ${reason}`);
    crashed = true;
    if (currentGeneration && !currentGeneration.reason) currentGeneration.reason = reason;
    return new KernelCrashedError(KernelState.current.reason ?? reason);
}

/** Whether the module still answers after an abort or trap (a failure inside the probe is not classified). */
function survives(): boolean {
    if (!probe) return true;
    probing = true;
    try {
        probe();
        return true;
    } catch {
        return false;
    } finally {
        probing = false;
    }
}

/**
 * What a guarded call throws instead of `error`: a {@link KernelCrashedError} once the kernel is
 * found dead, else `error` itself (an abort the module survived stays an ordinary failure).
 */
export function classifyKernelError(error: unknown): unknown {
    if (error instanceof KernelCrashedError || probing) return error;
    if (KernelState.current.isCrashed && !preparationGeneration)
        return crash(KernelState.current.reason ?? messageOf(error));
    const aborted = abortReason(error);
    const previousAbort = currentGeneration ? currentGeneration.lastAbort : lastAbort;
    if (aborted) {
        lastAbort = aborted;
        if (currentGeneration) currentGeneration.lastAbort = aborted;
        if (survives()) {
            Logger.warn(`geometry kernel aborted (${aborted}) and still answers`);
            return error;
        }
        return crash(aborted);
    }
    if (isRuntimeError(error) && FATAL_TRAP.test(messageOf(error))) {
        // A trap is not proof either: a null handle passed into a binding traps on its vtable call
        // ("null function or function signature mismatch") and the module is fine afterwards.
        const trap = messageOf(error);
        if (survives()) {
            Logger.warn(`geometry kernel trapped (${trap}) and still answers`);
            return error;
        }
        return crash(previousAbort ? `${trap}, after ${previousAbort}` : trap);
    }
    return error;
}

/** Emscripten's `onAbort(what)`: remembered, the guarded call it happens in decides. */
export function onKernelAbort(what: unknown): void {
    lastAbort = `Aborted(${String(what)})`;
    if (currentGeneration) currentGeneration.lastAbort = lastAbort;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Freeing a handle into a dead module could trap again; the memory is gone with it anyway. */
const RELEASE_METHODS = new Set(["delete", "deleteLater", "nullify"]);
/** Pure JS bookkeeping of embind's `ClassHandle`, safe after a crash. */
const JS_ONLY_METHODS = new Set(["isDeleted", "constructor"]);

function guardCall(fn: AnyFunction, generation: KernelGeneration, release = false): AnyFunction {
    const guarded = function (this: unknown, ...args: unknown[]) {
        if (release && (generation.reason || (crashed && preparationGeneration !== generation)))
            return undefined;
        assertGeneration(generation);
        assertOwnership(this, generation);
        for (const arg of args) assertOwnership(arg, generation);
        const previousGeneration = currentGeneration;
        const previousProbe = probe;
        currentGeneration = generation;
        probe = generation.probe;
        try {
            return fn.apply(this, args);
        } catch (error) {
            throw classifyKernelError(error);
        } finally {
            currentGeneration = previousGeneration;
            probe = previousProbe;
        }
    };
    // Embind's overload dispatcher reads `proto[name].overloadTable` at call time.
    return Object.assign(guarded, fn);
}

function guardMembers(target: object, skip: ReadonlySet<string>, generation: KernelGeneration): void {
    for (const key of Object.getOwnPropertyNames(target)) {
        if (skip.has(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (!descriptor?.configurable) continue;
        if (typeof descriptor.value === "function") {
            descriptor.value = guardCall(
                descriptor.value as AnyFunction,
                generation,
                RELEASE_METHODS.has(key),
            );
        } else if (descriptor.get || descriptor.set) {
            if (descriptor.get) descriptor.get = guardCall(descriptor.get as AnyFunction, generation);
            if (descriptor.set) descriptor.set = guardCall(descriptor.set as AnyFunction, generation);
        } else {
            continue;
        }
        Object.defineProperty(target, key, descriptor);
    }
}

/** An embind class: a constructor whose instances are `ClassHandle`s. */
function isEmbindClass(value: unknown): value is new (...args: unknown[]) => object {
    if (typeof value !== "function") return false;
    const prototype = (value as { prototype?: { delete?: unknown; isAliasOf?: unknown } }).prototype;
    return typeof prototype?.delete === "function" && typeof prototype?.isAliasOf === "function";
}

const STATIC_SKIP = new Set(["prototype", "length", "name", "arguments", "caller"]);

export interface KernelGuardOptions {
    /** Candidate instances are guarded without replacing the public error-classification context. */
    install?: boolean;
    /**
     * Run after an abort or a fatal-looking trap: throws when the module no longer works. Without
     * one the kernel is never marked crashed.
     */
    probe?: () => void;
}

/**
 * Guards every embind class of `module` in place: construction, static functions, and every
 * method / accessor along the prototype chains (`ClassHandle` included). A guarded call after the
 * crash throws {@link KernelCrashedError} without touching the module (`delete` becomes a no-op);
 * a call that breaks the module records the crash and throws it too. Enums and plain values are
 * untouched.
 */
export function guardKernelModule<M extends object>(module: M, options: KernelGuardOptions = {}): M {
    if (moduleGenerations.has(module)) return module;
    const generation: KernelGeneration = { probe: options.probe };
    moduleGenerations.set(module, generation);
    if (options.install !== false) installKernelModule(module);
    const prototypes = new Set<object>();
    const record = module as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(module)) {
        const value = record[key];
        if (!isEmbindClass(value)) continue;
        guardMembers(value, STATIC_SKIP, generation);
        for (
            let proto: object | null = value.prototype;
            proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)
        ) {
            prototypes.add(proto);
            prototypeGenerations.set(proto, generation);
        }
        record[key] = new Proxy(value, {
            construct(target, args) {
                assertGeneration(generation);
                for (const arg of args) assertOwnership(arg, generation);
                const previousGeneration = currentGeneration;
                const previousProbe = probe;
                currentGeneration = generation;
                probe = generation.probe;
                try {
                    return Reflect.construct(target, args);
                } catch (error) {
                    throw classifyKernelError(error);
                } finally {
                    currentGeneration = previousGeneration;
                    probe = previousProbe;
                }
            },
        });
    }
    for (const proto of prototypes) guardMembers(proto, JS_ONLY_METHODS, generation);
    return module;
}

/** Select the public generation only at initial installation or successful recovery publication. */
export function installKernelModule(module: object): void {
    const generation = moduleGenerations.get(module);
    if (!generation) throw new Error("Public kernel must be guarded before installation");
    currentGeneration = generation;
    probe = generation.probe;
    lastAbort = generation.lastAbort;
}

/**
 * Wraps a kernel facade whose methods return `Result` (the shape factory, the converter): once
 * the kernel crashed, a call returns `Result.err(<the stable message>)` without starting — also
 * the call that crashed it, whatever its own error text. Methods listed in `throwing` return
 * plain values and throw {@link KernelCrashedError} instead.
 */
export function guardKernelResults<T extends object>(target: T, throwing: readonly string[] = []): T {
    const throws = new Set(throwing);
    // Keyed by the function, not the name: a method replaced later (a test spy) is wrapped anew.
    const wrapped = new WeakMap<AnyFunction, AnyFunction>();
    return new Proxy(target, {
        get(obj, key, receiver) {
            const value = Reflect.get(obj, key, receiver);
            if (typeof value !== "function" || key === "constructor") return value;
            const fn = value as AnyFunction;
            let guarded = wrapped.get(fn);
            if (!guarded) {
                const isThrowing = typeof key === "string" && throws.has(key);
                guarded = (...args: unknown[]) => {
                    const failed = () => {
                        const error = new KernelCrashedError(KernelState.current.reason ?? "unknown error");
                        if (isThrowing) throw error;
                        return Result.err(error.message);
                    };
                    if (KernelState.current.isCrashed && !preparationGeneration) return failed();
                    let result: unknown;
                    try {
                        result = fn.apply(obj, args);
                    } catch (error) {
                        if (error instanceof KernelCrashedError) return failed();
                        throw error;
                    }
                    if (
                        KernelState.current.isCrashed &&
                        !preparationGeneration &&
                        result instanceof Result &&
                        !result.isOk
                    ) {
                        return failed();
                    }
                    return result;
                };
                wrapped.set(fn, guarded);
            }
            return guarded;
        },
    });
}
