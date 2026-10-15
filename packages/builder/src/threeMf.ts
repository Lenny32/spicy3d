// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IndexedMesh, LengthUnit } from "@spicy3d/core";

/** 3MF Core Specification namespace (the 2015/02 schema every slicer reads). */
export const THREE_MF_CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
export const THREE_MF_MODEL_PATH = "3D/3dmodel.model";
const MODEL_CONTENT_TYPE = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
const RELS_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml";
const START_PART_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

/** The `unit` attribute of each length unit; the vertices are written in that unit. */
export const THREE_MF_UNITS: Readonly<Record<LengthUnit, string>> = {
    mm: "millimeter",
    cm: "centimeter",
    m: "meter",
    in: "inch",
};

export interface ThreeMfObject {
    readonly name: string;
    /** Vertices already in the model's unit, world transform baked in. */
    readonly mesh: IndexedMesh;
    /** Its base material, `#RRGGBB` (sRGB, no alpha); none when omitted. */
    readonly material?: ThreeMfMaterial;
}

export interface ThreeMfMaterial {
    readonly name: string;
    readonly color: string;
}

export interface ThreeMfModel {
    readonly unit: LengthUnit;
    readonly objects: readonly ThreeMfObject[];
    readonly title?: string;
    /** `YYYY-MM-DD`. */
    readonly creationDate?: string;
}

/**
 * The `#RRGGBB` display colour of a material colour (a `0xRRGGBB` number or a CSS hex string),
 * or undefined when it is not one of those.
 */
export function threeMfColor(color: number | string | undefined): string | undefined {
    if (typeof color === "number") {
        if (!Number.isInteger(color) || color < 0) return undefined;
        return `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
    }
    const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color?.trim() ?? "")?.[1];
    if (!hex) return undefined;
    const rgb = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex.slice(0, 6);
    return `#${rgb.toUpperCase()}`;
}

function escapeXml(text: string): string {
    return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Shortest text keeping 9 significant digits (float32 exact); never `-0`, `NaN`. */
function formatNumber(value: number): string {
    const rounded = Number(value.toPrecision(9));
    return rounded === 0 ? "0" : String(rounded);
}

function meshXml(mesh: IndexedMesh, lines: string[]) {
    lines.push("      <mesh>", "        <vertices>");
    const { vertices, triangles } = mesh;
    for (let i = 0; i + 2 < vertices.length; i += 3) {
        lines.push(
            `          <vertex x="${formatNumber(vertices[i])}" y="${formatNumber(vertices[i + 1])}" z="${formatNumber(vertices[i + 2])}"/>`,
        );
    }
    lines.push("        </vertices>", "        <triangles>");
    for (let i = 0; i + 2 < triangles.length; i += 3) {
        lines.push(
            `          <triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`,
        );
    }
    lines.push("        </triangles>", "      </mesh>");
}

/** The `3D/3dmodel.model` part: one object and one build item per entry, colours as base materials. */
export function threeMfModelXml(model: ThreeMfModel): string {
    // One base per distinct material (name and colour), in order of first use.
    const keyOf = (material: ThreeMfMaterial) => `${material.name}\u0000${material.color}`;
    const bases = new Map<string, { index: number; material: ThreeMfMaterial }>();
    for (const { material } of model.objects) {
        if (material && !bases.has(keyOf(material)))
            bases.set(keyOf(material), { index: bases.size, material });
    }
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<model unit="${THREE_MF_UNITS[model.unit]}" xml:lang="en-US" xmlns="${THREE_MF_CORE_NAMESPACE}">`,
    ];
    if (model.title !== undefined)
        lines.push(`  <metadata name="Title">${escapeXml(model.title)}</metadata>`);
    lines.push('  <metadata name="Application">Spicy3D</metadata>');
    if (model.creationDate !== undefined)
        lines.push(`  <metadata name="CreationDate">${escapeXml(model.creationDate)}</metadata>`);
    lines.push("  <resources>");
    // Resource ids are shared by every resource kind: the material group takes 1.
    const materialsId = bases.size > 0 ? 1 : 0;
    if (bases.size > 0) {
        lines.push(`    <basematerials id="${materialsId}">`);
        for (const { material } of bases.values()) {
            lines.push(`      <base name="${escapeXml(material.name)}" displaycolor="${material.color}"/>`);
        }
        lines.push("    </basematerials>");
    }
    const objectIds = model.objects.map((_, i) => materialsId + 1 + i);
    model.objects.forEach((object, i) => {
        const base = object.material && bases.get(keyOf(object.material));
        const material = base ? ` pid="${materialsId}" pindex="${base.index}"` : "";
        lines.push(
            `    <object id="${objectIds[i]}" type="model" name="${escapeXml(object.name)}"${material}>`,
        );
        meshXml(object.mesh, lines);
        lines.push("    </object>");
    });
    lines.push("  </resources>", "  <build>");
    for (const id of objectIds) lines.push(`    <item objectid="${id}"/>`);
    lines.push("  </build>", "</model>", "");
    return lines.join("\n");
}

const CONTENT_TYPES_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    `  <Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>`,
    `  <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>`,
    "</Types>",
    "",
].join("\n");

const RELS_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `  <Relationship Target="/${THREE_MF_MODEL_PATH}" Id="rel0" Type="${START_PART_TYPE}"/>`,
    "</Relationships>",
    "",
].join("\n");

/** The 3MF package (an OPC zip): content types, the StartPart relationship and the model part. */
export async function write3mf(model: ThreeMfModel): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
    zip.file("_rels/.rels", RELS_XML);
    zip.file(THREE_MF_MODEL_PATH, threeMfModelXml(model));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
