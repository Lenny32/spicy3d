// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { KernelCrashedError, KernelState, Result } from "@spicy3d/core";
import {
    guardKernelModule,
    guardKernelResults,
    KernelHandleOwnershipError,
    onKernelAbort,
    retireKernelModule,
    runKernelPreparation,
} from "../src/kernelGuard";

// A stand-in for an embind module: classes whose prototypes carry `ClassHandle`'s `delete` /
// `isAliasOf`, static functions, accessors. `behaviour` decides what the next native call does.

type Behaviour = "ok" | "abort" | "trap" | "jsError";
let behaviour: Behaviour = "ok";
let abortMessage = "Aborted(undefined). Build with -sASSERTIONS for more info.";
let trapMessage = "table index is out of bounds";
const nativeCalls: string[] = [];

function native(name: string): number {
    nativeCalls.push(name);
    switch (behaviour) {
        case "abort":
            onKernelAbort(undefined);
            throw new WebAssembly.RuntimeError(abortMessage);
        case "trap":
            throw new WebAssembly.RuntimeError(trapMessage);
        case "jsError":
            throw new Error("BindingError: expected a TopoDS_Shape");
        default:
            return 42;
    }
}

function createModule() {
    class ClassHandle {
        delete() {
            nativeCalls.push("delete");
        }
        isAliasOf() {
            return false;
        }
        isDeleted() {
            return false;
        }
    }

    class FakeShape extends ClassHandle {
        constructor() {
            super();
            native("new FakeShape");
        }
        shapeType() {
            return native("shapeType");
        }
        get tolerance() {
            return native("tolerance");
        }
    }

    class FakeFactory extends ClassHandle {
        static box() {
            return native("box");
        }
    }

    return {
        FakeShape,
        FakeFactory,
        TopAbs_ShapeEnum: { TopAbs_EDGE: { value: 6 } },
        HEAPU8: new Uint8Array(4),
    };
}

// The prototypes are patched in place: guard them once, as `initWasm` does for its module.
let probeFails = false;
const probe = rs.fn(() => {
    if (probeFails) throw new WebAssembly.RuntimeError("table index is out of bounds");
});
let module: ReturnType<typeof createModule>;

beforeEach(() => {
    behaviour = "ok";
    abortMessage = "Aborted(undefined). Build with -sASSERTIONS for more info.";
    trapMessage = "table index is out of bounds";
    probeFails = false;
    nativeCalls.length = 0;
    probe.mockClear();
    module = guardKernelModule(createModule(), { probe });
});

afterEach(() => KernelState.current.reset());

const CRASHED = "Kernel crashed (Aborted(undefined)); reload the page";

describe("guardKernelModule", () => {
    test("passes calls through while the kernel works", () => {
        const shape = new module.FakeShape();
        expect(shape).toBeInstanceOf(module.FakeShape);
        expect(shape.shapeType()).toBe(42);
        expect(shape.tolerance).toBe(42);
        expect(module.FakeFactory.box()).toBe(42);
        expect(KernelState.current.status).toBe("ok");
        expect(module.TopAbs_ShapeEnum.TopAbs_EDGE.value).toBe(6);
    });

    test("an abort the module survives stays an ordinary error", () => {
        behaviour = "abort";
        expect(() => module.FakeFactory.box()).toThrow(WebAssembly.RuntimeError);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(KernelState.current.status).toBe("ok");

        behaviour = "ok";
        expect(module.FakeFactory.box()).toBe(42);
    });

    test("an abort the probe fails after crashes the kernel; later calls never reach it", () => {
        const shape = new module.FakeShape();
        behaviour = "abort";
        probeFails = true;
        expect(() => module.FakeFactory.box()).toThrow(new KernelCrashedError("Aborted(undefined)"));
        expect(KernelState.current.status).toBe("crashed");
        expect(KernelState.current.message).toBe(CRASHED);

        behaviour = "ok";
        nativeCalls.length = 0;
        expect(() => module.FakeFactory.box()).toThrow(CRASHED);
        expect(() => shape.shapeType()).toThrow(CRASHED);
        expect(() => shape.tolerance).toThrow(CRASHED);
        expect(() => new module.FakeShape()).toThrow(CRASHED);
        shape.delete(); // freeing into a dead module is a no-op
        expect(shape.isDeleted()).toBe(false);
        expect(nativeCalls).toEqual([]);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    test("a trap after an abort crashes the kernel, naming both", () => {
        behaviour = "abort";
        expect(() => module.FakeFactory.box()).toThrow(WebAssembly.RuntimeError);
        behaviour = "trap";
        probeFails = true;
        expect(() => module.FakeFactory.box()).toThrow(
            "Kernel crashed (table index is out of bounds, after Aborted(undefined)); reload the page",
        );
        expect(probe).toHaveBeenCalledTimes(2);
        expect(KernelState.current.status).toBe("crashed");
    });

    test.each([
        "unreachable",
        "table index is out of bounds",
        "null function or function signature mismatch",
        "memory access out of bounds",
    ])("the trap %s crashes the kernel when the probe fails", (message) => {
        behaviour = "trap";
        trapMessage = message;
        probeFails = true;
        expect(() => module.FakeFactory.box()).toThrow(KernelCrashedError);
        expect(KernelState.current.status).toBe("crashed");
        // An earlier test's abort may be named after it.
        expect(KernelState.current.reason?.startsWith(message)).toBe(true);
    });

    test("a trap the module survives stays an ordinary error", () => {
        behaviour = "trap";
        trapMessage = "null function or function signature mismatch";
        expect(() => module.FakeFactory.box()).toThrow(WebAssembly.RuntimeError);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(KernelState.current.status).toBe("ok");

        behaviour = "ok";
        expect(module.FakeFactory.box()).toBe(42);
    });

    test("an abort reason keeps its parentheses, without the build hint", () => {
        const reason =
            "Aborted(Cannot enlarge memory arrays to size 2147549184 bytes (OOM). Either (1) compile with " +
            "-sINITIAL_MEMORY=X with X higher than the current value 2147418112, (2) compile with " +
            "-sALLOW_MEMORY_GROWTH)";
        behaviour = "abort";
        abortMessage = `${reason}. Build with -sASSERTIONS for more info.`;
        probeFails = true;
        expect(() => module.FakeFactory.box()).toThrow(new KernelCrashedError(reason));
        expect(KernelState.current.reason).toBe(reason);
    });

    test("only the first crash counts", () => {
        const statuses: string[] = [];
        const listener = () => statuses.push(KernelState.current.status);
        KernelState.current.onPropertyChanged(listener);
        try {
            behaviour = "trap";
            probeFails = true;
            expect(() => new module.FakeShape()).toThrow(KernelCrashedError);
            expect(() => module.FakeFactory.box()).toThrow(KernelCrashedError);
            expect(KernelState.current.reason).toMatch(/^table index is out of bounds/);
        } finally {
            KernelState.current.removePropertyChanged(listener);
        }
        expect(statuses).toEqual(["crashed"]);
    });

    test("other errors pass through untouched", () => {
        behaviour = "jsError";
        expect(() => module.FakeFactory.box()).toThrow("BindingError: expected a TopoDS_Shape");
        expect(probe).not.toHaveBeenCalled();
        expect(KernelState.current.status).toBe("ok");
    });
});

class FakeFacade {
    readonly kernelName = "fake";
    box(): Result<number> {
        try {
            return Result.ok(module.FakeFactory.box());
        } catch (error) {
            return Result.err(`Box Error: ${error}`);
        }
    }
    edge(): number {
        return module.FakeFactory.box();
    }
}

describe("guardKernelResults", () => {
    const facade = guardKernelResults(new FakeFacade(), ["edge"]);

    test("passes results and properties through while the kernel works", () => {
        expect(facade.kernelName).toBe("fake");
        expect(facade.box().value).toBe(42);
        expect(facade).toBeInstanceOf(FakeFacade);
    });

    test("the crashing call and every later one return the stable message", () => {
        behaviour = "abort";
        probeFails = true;
        const crashed = facade.box();
        expect(crashed.isOk).toBe(false);
        expect(crashed.error).toBe(CRASHED);

        behaviour = "ok";
        nativeCalls.length = 0;
        expect(facade.box().error).toBe(CRASHED);
        expect(() => facade.edge()).toThrow(new KernelCrashedError("Aborted(undefined)"));
        expect(nativeCalls).toEqual([]);
    });

    test("an abort the module survives keeps the call's own error", () => {
        behaviour = "abort";
        const result = facade.box();
        expect(result.error).toContain("Box Error: RuntimeError: Aborted(undefined)");
        expect(KernelState.current.status).toBe("ok");
    });

    test("a method replaced later is guarded too", () => {
        const target = new FakeFacade();
        const guarded = guardKernelResults(target);
        const spy = rs.spyOn(target, "box").mockReturnValue(Result.ok(7));
        expect(guarded.box().value).toBe(7);
        KernelState.current.markCrashed("Aborted(undefined)");
        expect(guarded.box().error).toBe(CRASHED);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe("kernel generation ownership", () => {
    test("resetting public state never revives a crashed module", () => {
        const oldShape = new module.FakeShape();
        behaviour = "abort";
        probeFails = true;
        expect(() => oldShape.shapeType()).toThrow(KernelCrashedError);
        KernelState.current.reset();
        behaviour = "ok";
        const fresh = guardKernelModule(createModule(), { probe: () => {} });
        expect(new fresh.FakeShape().shapeType()).toBe(42);
        nativeCalls.length = 0;
        expect(() => oldShape.shapeType()).toThrow(KernelCrashedError);
        oldShape.delete();
        expect(nativeCalls).toEqual([]);
        expect(KernelState.current.status).toBe("ok");
    });

    test("retirement is permanent and cleanup does not enter native code", () => {
        const shape = new module.FakeShape();
        retireKernelModule(module);
        nativeCalls.length = 0;
        expect(() => shape.tolerance).toThrow(KernelCrashedError);
        expect(() => new module.FakeShape()).toThrow(KernelCrashedError);
        shape.delete();
        shape.delete();
        expect(nativeCalls).toEqual([]);
        expect(KernelState.current.status).toBe("ok");
    });

    test("borrowed receiver methods reject another generation before native entry", () => {
        const oldShape = new module.FakeShape();
        const fresh = guardKernelModule(createModule(), { probe: () => {} });
        const newShape = new fresh.FakeShape();
        nativeCalls.length = 0;
        expect(() => newShape.shapeType.call(oldShape)).toThrow(KernelHandleOwnershipError);
        expect(nativeCalls).toEqual([]);
        expect(newShape.shapeType()).toBe(42);
    });

    test("nested native arguments and constructor arguments cannot cross generations", () => {
        const oldShape = new module.FakeShape();
        const fresh = guardKernelModule(createModule(), { probe: () => {} });
        nativeCalls.length = 0;
        expect(() => Reflect.apply(fresh.FakeFactory.box, undefined, [[oldShape]])).toThrow(
            KernelHandleOwnershipError,
        );
        expect(() => Reflect.construct(fresh.FakeShape, [oldShape])).toThrow(KernelHandleOwnershipError);
        expect(nativeCalls).toEqual([]);
        expect(KernelState.current.status).toBe("ok");
    });
});

test("native preparation refuses asynchronous scope escape and restores public crash protection", () => {
    const fresh = guardKernelModule(createModule(), { probe: () => {} });
    KernelState.current.markCrashed("injected public crash");
    expect(() => runKernelPreparation(fresh, () => Promise.resolve())).toThrow("must be synchronous");
    expect(() => new fresh.FakeShape()).toThrow("injected public crash");
    expect(KernelState.current.status).toBe("crashed");
});
