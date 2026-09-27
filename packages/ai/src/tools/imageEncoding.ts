// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, Result } from "@spicy3d/core";
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

const DEFAULT_QUALITY = 0.85;
/** Below this longest side a screenshot is useless; an image that still does not fit is an error. */
const MIN_SIDE = 32;
const MAX_ATTEMPTS = 16;
/** Room kept in a relay message for the JSON-RPC envelope and the text part around the base64. */
const MAX_ENVELOPE_BYTES = 64 * 1024;

let callBudget: number | undefined;

/**
 * The base64 budget for images in one message of `maxMessageBytes` (the relay's limit, SRV-09):
 * always below the limit, whatever its size, so a screenshot that fits the budget fits the message.
 */
export function imageBudgetFor(maxMessageBytes: number): number {
    const envelope = Math.min(MAX_ENVELOPE_BYTES, Math.ceil(maxMessageBytes / 8));
    return Math.max(0, Math.floor(maxMessageBytes - envelope));
}

/**
 * Runs one tool call with an image budget: the remote relay's calls get one derived from its
 * `maxMessageBytes`, the in-app assistant none. Tool calls of the MCP server
 * run one at a time (one queue per page), so the budget never leaks into another server's call.
 */
export async function withImageByteBudget<T>(budget: number | undefined, run: () => Promise<T>): Promise<T> {
    const previous = callBudget;
    callBudget = budget;
    try {
        return await run();
    } finally {
        callBudget = previous;
    }
}

/** The budget of the tool call running now; undefined = no limit. */
export function imageByteBudget(): number | undefined {
    return callBudget;
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

function tooLarge(budget: number): string {
    return `the screenshot does not fit the relay's message limit (${budget} bytes of image data) even scaled down; ask the server administrator to raise Mcp__MaxMessageMb`;
}

/**
 * The view image (a data URL) in the requested encoding and size, within the call's byte budget.
 * Returns the image untouched when nothing is asked and it fits, so the default stays lossless PNG;
 * an image that cannot be made to fit is an error, never sent (the relay would drop the tab).
 */
export async function encodeImage(
    dataUrl: string,
    options: ImageEncodeOptions = {},
): Promise<Result<ImagePart, string>> {
    const budget = callBudget;
    const original = parseDataUrl(dataUrl);
    const fits = (image: ImagePart) => budget === undefined || image.data.length <= budget;
    const wantsFormat = options.format !== undefined && mediaTypeOf(options.format) !== original.mediaType;
    if (!wantsFormat && options.maxSize === undefined && fits(original)) return Result.ok(original);

    try {
        const image = await loadImage(dataUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        let format: ImageFormat = options.format ?? (original.mediaType === "image/png" ? "png" : "jpeg");
        let quality = options.quality ?? DEFAULT_QUALITY;
        let maxSize = options.maxSize;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const size = fit(width, height, maxSize);
            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const context = canvas.getContext("2d");
            if (!context) break;
            context.drawImage(image, 0, 0, size.width, size.height);
            const encoded = parseDataUrl(canvas.toDataURL(mediaTypeOf(format), quality));
            if (fits(encoded)) return Result.ok(encoded);
            const side = Math.max(size.width, size.height);
            if (side <= MIN_SIDE) break;
            // Too big for the relay: lossy from now on, then smaller.
            if (format === "png") format = "jpeg";
            else quality = Math.max(0.5, quality - 0.1);
            maxSize = Math.max(MIN_SIDE, Math.round(side * 0.75));
        }
    } catch (error) {
        Logger.warn(`[ai] screenshot not re-encoded: ${error}`);
    }
    // Could not re-encode (or not small enough): the original only when it fits.
    return fits(original) ? Result.ok(original) : Result.err(tooLarge(budget ?? 0));
}
