// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@spicy3d/core";
import type { ImagePart } from "../llm/types";

export type ImageFormat = "png" | "jpeg" | "webp";

export const IMAGE_FORMATS: readonly ImageFormat[] = ["png", "jpeg", "webp"];

export interface ImageEncodeOptions {
    /** Encoding of the result; default: the view's own (PNG). */
    format?: ImageFormat;
    /** Longest side in pixels; the image is scaled down (never up) to fit. */
    maxSize?: number;
    /** JPEG/WebP quality in (0, 1]; default 0.85. */
    quality?: number;
}

/** A floor for the budget, so a misconfigured relay cannot shrink screenshots to nothing. */
const MIN_BUDGET = 16 * 1024;
const DEFAULT_QUALITY = 0.85;
const MAX_ATTEMPTS = 6;

let byteBudget: number | undefined;

/**
 * The largest base64 image a tool result may carry, or undefined for no limit. The remote relay
 * sets it from its `maxMessageBytes` (SRV-09): a larger screenshot is re-encoded as JPEG and
 * scaled down until it fits, rather than breaking the connection (close 1009).
 */
export function setImageByteBudget(bytes: number | undefined): void {
    byteBudget = bytes === undefined ? undefined : Math.max(MIN_BUDGET, Math.floor(bytes));
}

export function imageByteBudget(): number | undefined {
    return byteBudget;
}

export function parseDataUrl(dataUrl: string): ImagePart {
    const comma = dataUrl.indexOf(",");
    const mediaType = dataUrl.slice(dataUrl.indexOf(":") + 1, dataUrl.indexOf(";")) || "image/png";
    return { mediaType, data: dataUrl.slice(comma + 1) };
}

function mediaTypeOf(format: ImageFormat): string {
    return `image/${format}`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("the view image could not be decoded"));
        image.src = url;
    });
}

function fit(width: number, height: number, max: number | undefined) {
    const scale = max && Math.max(width, height) > max ? max / Math.max(width, height) : 1;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The view image (a data URL) in the requested encoding and size, within the byte budget. Returns
 * the image untouched when nothing is asked and it fits, so the default stays lossless PNG.
 * Falls back to the original when the browser cannot re-encode (no canvas).
 */
export async function encodeImage(dataUrl: string, options: ImageEncodeOptions = {}): Promise<ImagePart> {
    const original = parseDataUrl(dataUrl);
    const wantsFormat = options.format !== undefined && mediaTypeOf(options.format) !== original.mediaType;
    const fits = byteBudget === undefined || original.data.length <= byteBudget;
    if (!wantsFormat && options.maxSize === undefined && fits) return original;

    try {
        const image = await loadImage(dataUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        let format: ImageFormat = options.format ?? (original.mediaType === "image/png" ? "png" : "jpeg");
        let quality = options.quality ?? DEFAULT_QUALITY;
        let maxSize = options.maxSize;
        let encoded: ImagePart = original;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const size = fit(width, height, maxSize);
            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const context = canvas.getContext("2d");
            if (!context) return original;
            context.drawImage(image, 0, 0, size.width, size.height);
            encoded = parseDataUrl(canvas.toDataURL(mediaTypeOf(format), quality));
            if (byteBudget === undefined || encoded.data.length <= byteBudget) return encoded;
            // Too big for the relay: lossy from now on, then smaller.
            if (format === "png") format = "jpeg";
            else quality = Math.max(0.5, quality - 0.1);
            maxSize = Math.round(Math.max(size.width, size.height) * 0.75);
        }
        return encoded;
    } catch (error) {
        Logger.warn(`[ai] screenshot not re-encoded: ${error}`);
        return original;
    }
}
