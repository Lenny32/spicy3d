// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    encodeImage,
    imageBudgetFor,
    imageByteBudget,
    parseDataUrl,
    withImageByteBudget,
} from "../src/tools/imageEncoding";
import { imageResult, parseImageOptions } from "../src/tools/viewTools";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** An image that "decodes" at once to 2000×1000, and canvases whose output size follows their pixels. */
function stubCanvas() {
    const encoded: { type: string; quality?: number; width: number; height: number }[] = [];
    class FakeImage {
        naturalWidth = 2000;
        naturalHeight = 1000;
        width = 2000;
        height = 1000;
        onload?: () => void;
        onerror?: () => void;
        set src(_url: string) {
            queueMicrotask(() => this.onload?.());
        }
    }
    rs.stubGlobal("Image", FakeImage);
    const create = document.createElement.bind(document);
    const spy = rs.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        if (tag !== "canvas") return create(tag);
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => {} }),
            toDataURL: (type: string, quality?: number) => {
                encoded.push({ type, quality, width: canvas.width, height: canvas.height });
                // 1 base64 character per 25 pixels, half that when lossy.
                const size = (canvas.width * canvas.height) / (type === "image/png" ? 25 : 50);
                return `data:${type};base64,${"A".repeat(Math.round(size))}`;
            },
        };
        return canvas;
    }) as typeof document.createElement);
    return { encoded, restore: () => spy.mockRestore() };
}

describe("parseImageOptions", () => {
    test("accepts format, maxSize and quality", () => {
        expect(parseImageOptions({ format: "jpeg", maxSize: 1024, quality: 0.7 })).toEqual({
            format: "jpeg",
            maxSize: 1024,
            quality: 0.7,
        });
        expect(parseImageOptions({})).toEqual({});
    });

    test.each([
        [{ format: "gif" }, "format"],
        [{ maxSize: 10 }, "maxSize"],
        [{ maxSize: 100.5 }, "maxSize"],
        [{ quality: 0 }, "quality"],
        [{ quality: 2 }, "quality"],
    ])("refuses %j", (args, message) => {
        expect(parseImageOptions(args)).toContain(message);
    });
});

describe("image budget", () => {
    test.each([
        1 << 20,
        10 << 20,
        100_000,
        5_000,
    ])("the budget for %i bytes stays below the message limit", (max) => {
        const budget = imageBudgetFor(max);
        expect(budget).toBeGreaterThan(0);
        expect(budget).toBeLessThan(max);
    });

    test("applies only inside the call that set it", async () => {
        expect(imageByteBudget()).toBeUndefined();
        const inside = await withImageByteBudget(1234, async () => imageByteBudget());
        expect(inside).toBe(1234);
        expect(imageByteBudget()).toBeUndefined();
    });
});

/** A browser that cannot decode (or re-encode) the view image. */
function stubBrokenImage() {
    class BrokenImage {
        onload?: () => void;
        onerror?: () => void;
        set src(_url: string) {
            queueMicrotask(() => this.onerror?.());
        }
    }
    rs.stubGlobal("Image", BrokenImage);
}

describe("encodeImage", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    test("leaves the view's PNG untouched when nothing is asked and it fits", async () => {
        expect((await encodeImage(PNG)).value).toEqual(parseDataUrl(PNG));
        const within = await withImageByteBudget(1 << 20, () => encodeImage(PNG));
        expect(within.value).toEqual({ mediaType: "image/png", data: "iVBORw0KGgo=" });
    });

    test("scales to maxSize and encodes the requested format", async () => {
        const canvas = stubCanvas();
        try {
            const image = await encodeImage(PNG, { format: "jpeg", maxSize: 800, quality: 0.6 });

            expect(image.isOk).toBe(true);
            expect(image.value.mediaType).toBe("image/jpeg");
            expect(canvas.encoded).toEqual([{ type: "image/jpeg", quality: 0.6, width: 800, height: 400 }]);
        } finally {
            canvas.restore();
        }
    });

    test("an image over the relay's budget turns lossy, then smaller, until it fits", async () => {
        const canvas = stubCanvas();
        const big = `data:image/png;base64,${"A".repeat(40_000)}`;
        try {
            const image = await withImageByteBudget(20_000, () => encodeImage(big));

            expect(image.isOk).toBe(true);
            expect(image.value.data.length).toBeLessThanOrEqual(20_000);
            expect(canvas.encoded.map((e) => e.type)).toEqual(["image/png", "image/jpeg", "image/jpeg"]);
            expect(canvas.encoded[0]).toMatchObject({ width: 2000, height: 1000 });
            expect(canvas.encoded.at(-1)?.width).toBeLessThan(2000);
        } finally {
            canvas.restore();
        }
    });

    test("an image that cannot be made to fit is an error, never sent", async () => {
        const canvas = stubCanvas();
        const big = `data:image/png;base64,${"A".repeat(40_000)}`;
        try {
            const image = await withImageByteBudget(5, () => encodeImage(big));

            expect(image.isOk).toBe(false);
            expect(image.error).toContain("message limit");
        } finally {
            canvas.restore();
        }
    });

    test("without a canvas, an image over the budget is an error too", async () => {
        stubBrokenImage();
        const big = `data:image/png;base64,${"A".repeat(40_000)}`;
        const image = await withImageByteBudget(1000, () => encodeImage(big));
        expect(image.isOk).toBe(false);
    });
});

describe("imageResult", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    test("passes the screenshot through as an image part and names its type", async () => {
        const result = await imageResult({ toImage: () => PNG }, { ok: true });

        expect(result.images).toEqual([{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
        expect(JSON.parse(result.content)).toEqual({ ok: true, mediaType: "image/png" });
    });

    test("a screenshot too large for the relay becomes an error result, without the image", async () => {
        stubBrokenImage();
        const big = `data:image/png;base64,${"A".repeat(40_000)}`;
        const result = await withImageByteBudget(1000, () =>
            imageResult({ toImage: () => big }, { ok: true }),
        );

        expect(result.images).toBeUndefined();
        expect(JSON.parse(result.content).error).toContain("message limit");
    });
});
