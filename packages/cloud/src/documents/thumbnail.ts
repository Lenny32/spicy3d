// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@spicy3d/core";

/** The server's thumbnail rules (SpicySrv `ThumbnailImage`): PNG or WebP, ≤ 512×512, ≤ 256 KiB. */
export const THUMBNAIL_MAX_DIMENSION = 512;
export const THUMBNAIL_MAX_BYTES = 256 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes: Uint8Array, start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

/** The image type of a thumbnail's bytes (from the magic bytes), `undefined` for anything else. */
export function thumbnailType(bytes: Uint8Array): "image/png" | "image/webp" | undefined {
    if (PNG.every((b, i) => bytes[i] === b)) return "image/png";
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
        return "image/webp";
    }
    return undefined;
}

/** Pixel size read from a PNG or WebP header, as the server reads it; `undefined` if unreadable. */
export function thumbnailSize(bytes: Uint8Array): { width: number; height: number } | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = thumbnailType(bytes);
    if (type === "image/png" && bytes.length >= 24 && ascii(bytes, 12, 16) === "IHDR") {
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type !== "image/webp" || bytes.length < 30) return undefined;
    const chunk = ascii(bytes, 12, 16);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
        return {
            width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
            height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
        };
    }
    return undefined;
}

/** Whether the server accepts these bytes as a thumbnail. */
export function isAcceptableThumbnail(bytes: Uint8Array): boolean {
    const size = thumbnailSize(bytes);
    return (
        bytes.length <= THUMBNAIL_MAX_BYTES &&
        size !== undefined &&
        size.width > 0 &&
        size.height > 0 &&
        size.width <= THUMBNAIL_MAX_DIMENSION &&
        size.height <= THUMBNAIL_MAX_DIMENSION
    );
}

/** The width and height fitting `width`×`height` into `max`×`max`, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
    const scale = Math.min(1, max / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("the view image could not be decoded"));
        image.src = url;
    });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * A view image (`toImage()`'s data URL) as a thumbnail the server accepts: downscaled to fit
 * 512×512, WebP where the browser can encode it (PNG otherwise), shrunk further until it is at most
 * 256 KiB. `undefined` when the browser can't produce one: the version is then saved without.
 */
export async function encodeThumbnail(imageUrl: string): Promise<Uint8Array | undefined> {
    try {
        const image = await loadImage(imageUrl);
        let max = THUMBNAIL_MAX_DIMENSION;
        for (let attempt = 0; attempt < 5; attempt++, max = Math.floor(max * 0.7)) {
            const size = fitWithin(
                image.naturalWidth || image.width,
                image.naturalHeight || image.height,
                max,
            );
            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const context = canvas.getContext("2d");
            if (!context) return undefined;
            context.drawImage(image, 0, 0, size.width, size.height);
            // A browser that can't encode WebP answers PNG instead.
            const blob =
                (await canvasBlob(canvas, "image/webp", 0.82)) ?? (await canvasBlob(canvas, "image/png"));
            if (!blob) return undefined;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (isAcceptableThumbnail(bytes)) return bytes;
        }
    } catch (error) {
        Logger.warn(`[cloud] no thumbnail: ${error}`);
    }
    return undefined;
}
