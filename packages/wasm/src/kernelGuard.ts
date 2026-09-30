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
 * be re-created either — every `OccShape` wraps a handle into it.
 *
 * So after an abort or a trap (`unreachable`, `table index is out of bounds`, …) a small probe runs
 * against the module: if the probe fails, the kernel is recorded as crashed in core's
 * `KernelState` with the first message, and from then on nothing re-enters the module: every call
 * fails at once with one stable message ({@link KernelCrashedError}).
 *
 * The glue's `FinalizationRegistry` may still call the dead module's destructors when handles are
 * garbage-collected after a crash: console noise only, and it cannot be intercepted from JS.
 */

/** Traps that may mean a corrupted module; the probe decides. */
const FATAL_TRAP =
    /unreachable|table index is out of bounds|null function or function signature mismatch|memory access out of bounds/i;

let probe: (() => void) | undefined;
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
    if (KernelState.current.isCrashed) return crash(KernelState.current.reason ?? messageOf(error));
    const aborted = abortReason(error);
    if (aborted) {
        lastAbort = aborted;
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
        return crash(lastAbort ? `${trap}, after ${lastAbort}` : trap);
    }
    return error;
}

/** Emscripten's `onAbort(what)`: remembered, the guarded call it happens in decides. */
export function onKernelAbort(what: unknown): void {
    lastAbort = `Aborted(${String(what)})`;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Freeing a handle into a dead module could trap again; the memory is gone with it anyway. */
const RELEASE_METHODS = new Set(["delete", "deleteLater"]);
/** Pure JS bookkeeping of embind's `ClassHandle`, safe after a crash. */
const JS_ONLY_METHODS = new Set(["isDeleted", "isAliasOf", "clone", "constructor"]);

function guardCall(fn: AnyFunction, release = false): AnyFunction {
    const guarded = function (this: unknown, ...args: unknown[]) {
        if (crashed) {
            if (release) return undefined;
            KernelState.current.throwIfCrashed();
        }
        try {
            return fn.apply(this, args);
        } catch (error) {
            throw classifyKernelError(error);
        }
    };
    // Embind's overload dispatcher reads `proto[name].overloadTable` at call time.
    return Object.assign(guarded, fn);
}

function guardMembers(target: object, skip: ReadonlySet<string>): void {
    for (const key of Object.getOwnPropertyNames(target)) {
        if (skip.has(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (!descriptor?.configurable) continue;
        if (typeof descriptor.value === "function") {
            descriptor.value = guardCall(descriptor.value as AnyFunction, RELEASE_METHODS.has(key));
        } else if (descriptor.get || descriptor.set) {
            if (descriptor.get) descriptor.get = guardCall(descriptor.get as AnyFunction);
            if (descriptor.set) descriptor.set = guardCall(descriptor.set as AnyFunction);
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
    probe = options.probe;
    lastAbort = undefined;
    const prototypes = new Set<object>();
    const record = module as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(module)) {
        const value = record[key];
        if (!isEmbindClass(value)) continue;
        guardMembers(value, STATIC_SKIP);
        for (
            let proto: object | null = value.prototype;
            proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)
        ) {
            prototypes.add(proto);
        }
        record[key] = new Proxy(value, {
            construct(target, args) {
                if (crashed) KernelState.current.throwIfCrashed();
                try {
                    return Reflect.construct(target, args);
                } catch (error) {
                    throw classifyKernelError(error);
                }
            },
        });
    }
    for (const proto of prototypes) guardMembers(proto, JS_ONLY_METHODS);
    return module;
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
                    if (KernelState.current.isCrashed) return failed();
                    let result: unknown;
                    try {
                        result = fn.apply(obj, args);
                    } catch (error) {
                        if (error instanceof KernelCrashedError) return failed();
                        throw error;
                    }
                    if (KernelState.current.isCrashed && result instanceof Result && !result.isOk) {
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
