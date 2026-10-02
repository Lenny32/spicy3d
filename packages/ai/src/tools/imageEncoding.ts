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
const MAX_ATTEMPTS = 4;
/** Room kept in a relay message for the JSON-RPC envelope and the text part around the base64. */
const MAX_ENVELOPE_BYTES = 64 * 1024;

/** Calls in flight, oldest first; a finished call removes only its own entry. */
const activeBudgets: { budget: number | undefined }[] = [];

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
 * `maxMessageBytes`, the in-app assistant none. Calls can overlap (a screenshot or metadata read
 * runs while a program yields), so each call keeps its own entry instead of saving and restoring
 * one value: a call ending out of order never brings back a budget whose call has finished.
 */
export async function withImageByteBudget<T>(budget: number | undefined, run: () => Promise<T>): Promise<T> {
    const entry = { budget };
    activeBudgets.push(entry);
    try {
        return await run();
    } finally {
        activeBudgets.splice(activeBudgets.indexOf(entry), 1);
    }
}

/** The budget of the most recently started tool call still running; undefined = no limit. */
export function imageByteBudget(): number | undefined {
    return activeBudgets.at(-1)?.budget;
}

export function parseDataUrl(dataUrl: string): ImagePart {
    const comma = dataUrl.indexOf(",");
    const mediaType = dataUrl.slice(dataUrl.indexOf(":") + 1, dataUrl.indexOf(";")) || "image/png";
    return { mediaType, data: dataUrl.slice(comma + 1) };
}

function mediaTypeOf(format: ImageFormat): string {
    return `image/${format}`;
}

/** Longest side a screenshot gets by default: vision models downscale anything larger anyway. */
export const DEFAULT_MAX_SIZE = 1568;

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

/** `source` drawn at `size`, or `source` itself when it already has that size. */
function scaled(
    source: CanvasImageSource,
    width: number,
    height: number,
    size: { width: number; height: number },
) {
    if (source instanceof HTMLCanvasElement && size.width === width && size.height === height) return source;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size.width, size.height);
    return canvas;
}

/**
 * The canvas encoded without blocking the page: `toBlob` encodes off the main thread (a
 * synchronous `toDataURL` of a large viewport froze the tab), and `FileReader` does the base64.
 */
async function encodeCanvas(
    canvas: HTMLCanvasElement,
    format: ImageFormat,
    quality: number,
): Promise<ImagePart> {
    const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, mediaTypeOf(format), quality),
    );
    if (!blob) throw new Error(`the browser cannot encode ${format}`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("the screenshot could not be read"));
        reader.readAsDataURL(blob);
    });
    // Some browsers answer another type than asked (no WebP encoder): report what was produced.
    return parseDataUrl(dataUrl);
}

/**
 * `source` encoded in the requested format and size, within the call's byte budget. An image over
 * the budget turns lossy first, then shrinks by the ratio it missed by, so it fits in two or three
 * encodes; one that still does not fit is an error, never sent (the relay would drop the tab).
 */
async function encodeWithin(
    source: CanvasImageSource,
    width: number,
    height: number,
    options: ImageEncodeOptions & { format: ImageFormat },
    budget: number | undefined,
): Promise<Result<ImagePart, string>> {
    let { format, maxSize } = options;
    const quality = options.quality ?? DEFAULT_QUALITY;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const size = fit(width, height, maxSize);
        const canvas = scaled(source, width, height, size);
        if (!canvas) break;
        const encoded = await encodeCanvas(canvas, format, quality);
        if (budget === undefined || encoded.data.length <= budget) return Result.ok(encoded);
        const side = Math.max(size.width, size.height);
        if (side <= MIN_SIDE) break;
        if (format === "png") {
            format = "jpeg";
            continue;
        }
        // The byte count follows the pixel count: shrink both sides by the square root of the miss.
        const ratio = Math.sqrt(budget / encoded.data.length) * 0.9;
        maxSize = Math.max(MIN_SIDE, Math.floor(side * Math.min(0.9, ratio)));
    }
    return Result.err(tooLarge(budget ?? 0));
}

/**
 * A view snapshot (`IView.snapshot`, already at its final size and opaque) encoded for a tool
 * result: PNG unless another format is asked, within the call's byte budget.
 */
export async function encodeSnapshot(
    canvas: HTMLCanvasElement,
    options: ImageEncodeOptions = {},
): Promise<Result<ImagePart, string>> {
    try {
        return await encodeWithin(
            canvas,
            canvas.width,
            canvas.height,
            { ...options, format: options.format ?? "png" },
            imageByteBudget(),
        );
    } catch (error) {
        Logger.warn(`[ai] screenshot not encoded: ${error}`);
        return Result.err(`the screenshot could not be encoded: ${error}`);
    }
}

/**
 * The view image (a data URL) in the requested encoding and size, within the call's byte budget —
 * the path for views that cannot give a snapshot. Returns the image untouched when nothing is asked
 * and it fits, so the default stays lossless PNG.
 */
export async function encodeImage(
    dataUrl: string,
    options: ImageEncodeOptions = {},
): Promise<Result<ImagePart, string>> {
    const budget = imageByteBudget();
    const original = parseDataUrl(dataUrl);
    const fits = (image: ImagePart) => budget === undefined || image.data.length <= budget;
    const wantsFormat = options.format !== undefined && mediaTypeOf(options.format) !== original.mediaType;
    if (!wantsFormat && options.maxSize === undefined && fits(original)) return Result.ok(original);

    try {
        const image = await loadImage(dataUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        // The original PNG is known not to fit: encoding it again as PNG would only lose time.
        const format: ImageFormat =
            options.format ?? (original.mediaType === "image/png" && fits(original) ? "png" : "jpeg");
        const encoded = await encodeWithin(image, width, height, { ...options, format }, budget);
        if (encoded.isOk) return encoded;
    } catch (error) {
        Logger.warn(`[ai] screenshot not re-encoded: ${error}`);
    }
    // Could not re-encode (or not small enough): the original only when it fits.
    return fits(original) ? Result.ok(original) : Result.err(tooLarge(budget ?? 0));
}
