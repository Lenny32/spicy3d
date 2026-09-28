// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Build-time codegen: reads a TrueType font (glyf outlines) and emits the glyph outlines the
// sketch text uses (packages/parametric/src/sketch/fonts/notoSans.generated.ts). The outlines
// are baked into the source instead of parsing a font at runtime so text geometry is identical
// on every device and in the headless merge evaluator, and no font file or parser ships.
//
// Run: node scripts/generate-font-outlines.mjs <NotoSans-Regular.ttf>
// (Noto Sans, OFL-1.1 — Debian/Ubuntu: /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf,
// or https://notofonts.github.io). The license travels next to the output (LICENSE-OFL.txt).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outPath = resolve(root, "packages/parametric/src/sketch/fonts/notoSans.generated.ts");

/** Printable ASCII, Latin-1 and a few typographic marks. */
const CODE_POINTS = [
    ...range(0x20, 0x7e),
    ...range(0xa0, 0xff),
    0x2013,
    0x2014,
    0x2018,
    0x2019,
    0x201c,
    0x201d,
    0x2022,
    0x2026,
    0x20ac,
];

function range(from, to) {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const fontPath = process.argv[2];
if (fontPath === undefined) {
    console.error("usage: node scripts/generate-font-outlines.mjs <NotoSans-Regular.ttf>");
    process.exit(1);
}
const buffer = readFileSync(fontPath);
const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const tables = readTableDirectory();
const head = tables.get("head");
const unitsPerEm = view.getUint16(head + 18);
const longLoca = view.getInt16(head + 50) === 1;
const numGlyphs = view.getUint16(tables.get("maxp") + 4);
const hhea = tables.get("hhea");
const numberOfHMetrics = view.getUint16(hhea + 34);
const os2 = tables.get("OS/2");
const capHeight = view.getUint16(os2) >= 2 ? view.getInt16(os2 + 88) : Math.round(unitsPerEm * 0.7);
const cmap = readCmap();

const glyphs = {};
for (const codePoint of CODE_POINTS) {
    const glyph = cmap.get(codePoint);
    if (glyph === undefined) continue;
    glyphs[String.fromCodePoint(codePoint)] = [advanceOf(glyph), pathOf(glyphContours(glyph, 0))];
}

writeFileSync(outPath, render());
console.log(`wrote ${Object.keys(glyphs).length} glyphs to ${outPath}`);

function readTableDirectory() {
    const count = view.getUint16(4);
    const result = new Map();
    for (let i = 0; i < count; i++) {
        const record = 12 + i * 16;
        const tag = String.fromCharCode(...buffer.subarray(record, record + 4));
        result.set(tag, view.getUint32(record + 8));
    }
    for (const tag of ["head", "maxp", "hhea", "hmtx", "OS/2", "cmap", "loca", "glyf"]) {
        if (!result.has(tag)) throw new Error(`Not a TrueType-outline font: no ${tag} table`);
    }
    return result;
}

/** Code point → glyph index, from the Windows Unicode (format 4) subtable. */
function readCmap() {
    const base = tables.get("cmap");
    const count = view.getUint16(base + 2);
    for (let i = 0; i < count; i++) {
        const platform = view.getUint16(base + 4 + i * 8);
        const encoding = view.getUint16(base + 6 + i * 8);
        const offset = base + view.getUint32(base + 8 + i * 8);
        if (platform === 3 && encoding === 1 && view.getUint16(offset) === 4) return readFormat4(offset);
    }
    throw new Error("No Unicode BMP cmap subtable");
}

function readFormat4(offset) {
    const segCount = view.getUint16(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const rangeOffsets = deltas + segCount * 2;
    const map = new Map();
    for (let s = 0; s < segCount; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getInt16(deltas + s * 2);
        const rangeOffset = view.getUint16(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
            let glyph;
            if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
            else {
                const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
                glyph = view.getUint16(at);
                if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
            }
            if (glyph !== 0) map.set(c, glyph);
        }
    }
    return map;
}

function advanceOf(glyph) {
    const index = Math.min(glyph, numberOfHMetrics - 1);
    return view.getUint16(tables.get("hmtx") + index * 4);
}

function glyphOffset(glyph) {
    const loca = tables.get("loca");
    const [from, to] = longLoca
        ? [view.getUint32(loca + glyph * 4), view.getUint32(loca + glyph * 4 + 4)]
        : [view.getUint16(loca + glyph * 2) * 2, view.getUint16(loca + glyph * 2 + 2) * 2];
    return from === to ? undefined : tables.get("glyf") + from;
}

/** The glyph's contours as point lists `{x, y, on}` in font units (composites resolved). */
function glyphContours(glyph, depth) {
    if (glyph >= numGlyphs || depth > 8) return [];
    const offset = glyphOffset(glyph);
    if (offset === undefined) return [];
    const contourCount = view.getInt16(offset);
    return contourCount >= 0 ? simpleContours(offset, contourCount) : compositeContours(offset, depth);
}

function simpleContours(offset, contourCount) {
    let at = offset + 10;
    const endPoints = [];
    for (let i = 0; i < contourCount; i++, at += 2) endPoints.push(view.getUint16(at));
    const pointCount = contourCount === 0 ? 0 : endPoints[contourCount - 1] + 1;
    at += 2 + view.getUint16(at); // skip the instructions
    const flags = [];
    while (flags.length < pointCount) {
        const flag = view.getUint8(at++);
        flags.push(flag);
        if (flag & 8) {
            const repeat = view.getUint8(at++);
            for (let r = 0; r < repeat; r++) flags.push(flag);
        }
    }
    const readCoords = (shortBit, sameBit) => {
        const values = [];
        let value = 0;
        for (const flag of flags) {
            if (flag & shortBit) {
                const delta = view.getUint8(at++);
                value += flag & sameBit ? delta : -delta;
            } else if (!(flag & sameBit)) {
                value += view.getInt16(at);
                at += 2;
            }
            values.push(value);
        }
        return values;
    };
    const xs = readCoords(2, 16);
    const ys = readCoords(4, 32);
    const contours = [];
    let start = 0;
    for (const end of endPoints) {
        const points = [];
        for (let i = start; i <= end; i++) points.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        contours.push(points);
        start = end + 1;
    }
    return contours;
}

function compositeContours(offset, depth) {
    let at = offset + 10;
    const contours = [];
    for (;;) {
        const flags = view.getUint16(at);
        const component = view.getUint16(at + 2);
        at += 4;
        let dx;
        let dy;
        if (flags & 1) {
            dx = view.getInt16(at);
            dy = view.getInt16(at + 2);
            at += 4;
        } else {
            dx = view.getInt8(at);
            dy = view.getInt8(at + 1);
            at += 2;
        }
        if (!(flags & 2)) throw new Error("Point-matched composite glyphs are not supported");
        let [a, b, c, d] = [1, 0, 0, 1];
        const f2dot14 = (p) => view.getInt16(p) / 16384;
        if (flags & 8) {
            a = d = f2dot14(at);
            at += 2;
        } else if (flags & 0x40) {
            a = f2dot14(at);
            d = f2dot14(at + 2);
            at += 4;
        } else if (flags & 0x80) {
            [a, b, c, d] = [f2dot14(at), f2dot14(at + 2), f2dot14(at + 4), f2dot14(at + 6)];
            at += 8;
        }
        for (const contour of glyphContours(component, depth + 1)) {
            contours.push(
                contour.map((p) => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })),
            );
        }
        if (!(flags & 0x20)) return contours;
    }
}

/**
 * The contours as a compact path: `M x y` starts a contour, `L x y` a line, `Q cx cy x y` a
 * quadratic segment; every contour is closed back to its start. Implied on-curve points
 * between consecutive off-curve points are made explicit; degenerate segments are dropped.
 */
function pathOf(contours) {
    const parts = [];
    for (const contour of contours) {
        const segments = contourSegments(contour);
        if (segments.length < 2) continue;
        const [x0, y0] = segments[0].from;
        parts.push(`M${num(x0)} ${num(y0)}`);
        for (const segment of segments) {
            parts.push(
                segment.control === undefined
                    ? `L${num(segment.to[0])} ${num(segment.to[1])}`
                    : `Q${num(segment.control[0])} ${num(segment.control[1])} ${num(segment.to[0])} ${num(segment.to[1])}`,
            );
        }
    }
    return parts.join("");
}

function contourSegments(points) {
    if (points.length < 2) return [];
    // Start on an on-curve point (or the implied midpoint of two off-curve ones).
    const first = points.findIndex((p) => p.on);
    let start;
    let ordered;
    if (first < 0) {
        start = mid(points[0], points[1]);
        ordered = [...points.slice(1), points[0]];
    } else {
        start = [points[first].x, points[first].y];
        ordered = [...points.slice(first + 1), ...points.slice(0, first)];
    }
    const segments = [];
    let current = start;
    let control;
    const push = (to, ctrl) => {
        if (same(current, to)) return;
        if (ctrl !== undefined && (same(ctrl, current) || same(ctrl, to))) ctrl = undefined;
        segments.push({ from: current, to, control: ctrl });
        current = to;
    };
    for (const p of [...ordered, { x: start[0], y: start[1], on: true }]) {
        const xy = [p.x, p.y];
        if (p.on) {
            push(xy, control);
            control = undefined;
        } else if (control === undefined) {
            control = xy;
        } else {
            push(mid({ x: control[0], y: control[1] }, p), control);
            control = xy;
        }
    }
    return segments;
}

function mid(p, q) {
    return [(p.x + q.x) / 2, (p.y + q.y) / 2];
}

function same(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function num(value) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function render() {
    const entries = Object.entries(glyphs)
        .map(
            ([char, [advance, path]]) =>
                `    ${JSON.stringify(char)}: [${advance}, ${JSON.stringify(path)}],`,
        )
        .join("\n");
    return `// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// GENERATED by scripts/generate-font-outlines.mjs — do not edit by hand.
// Glyph outlines of Noto Sans Regular (Copyright 2012-2020 Google Inc. / Google LLC), licensed under
// the SIL Open Font License 1.1 — see LICENSE-OFL.txt next to this file.

import type { FontOutlines } from "./fontOutlines";

export const NOTO_SANS: FontOutlines = {
    unitsPerEm: ${unitsPerEm},
    capHeight: ${capHeight},
    glyphs: {
${entries}
    },
};
`;
}
