// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    fitWithin,
    isAcceptableThumbnail,
    THUMBNAIL_MAX_BYTES,
    thumbnailSize,
    thumbnailType,
} from "../src/documents/thumbnail";

function png(width: number, height: number, size = 33): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

/** A lossless WebP (VP8L) header. */
function webp(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(40);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
    bytes[20] = 0x2f;
    new DataView(bytes.buffer).setUint32(21, ((height - 1) << 14) | (width - 1), true);
    return bytes;
}

describe("thumbnails", () => {
    test("reads the type and size of PNG and WebP headers like the server", () => {
        expect(thumbnailType(png(10, 10))).toBe("image/png");
        expect(thumbnailSize(png(320, 200))).toEqual({ width: 320, height: 200 });
        expect(thumbnailType(webp(5, 7))).toBe("image/webp");
        expect(thumbnailSize(webp(512, 300))).toEqual({ width: 512, height: 300 });
        expect(thumbnailType(new TextEncoder().encode("GIF89a........"))).toBeUndefined();
    });

    test.each([
        [png(512, 512), true],
        [png(513, 100), false],
        [webp(512, 1), true],
        [webp(600, 400), false],
        [png(100, 100, THUMBNAIL_MAX_BYTES + 1), false],
        [new Uint8Array(40), false],
    ])("accepts only ≤512×512 PNG/WebP of at most 256 KiB (%#)", (bytes, accepted) => {
        expect(isAcceptableThumbnail(bytes)).toBe(accepted);
    });

    test("downscales to fit 512×512, keeping the aspect ratio, never upscaling", () => {
        expect(fitWithin(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
        expect(fitWithin(600, 1200, 512)).toEqual({ width: 256, height: 512 });
        expect(fitWithin(200, 100, 512)).toEqual({ width: 200, height: 100 });
    });
});
