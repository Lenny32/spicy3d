// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    type IWire,
    Precision,
    Result,
    ShapeTypes,
    ShapeTypeUtils,
    type XYZ,
} from "@spicy3d/core";

/**
 * Groups edges into connected chains: two edges belong to one chain when an endpoint of
 * one coincides with an endpoint of the other (within `Precision.Distance`, the tolerance
 * the kernel's wire builder chains with). Chains keep the input order of their first edge.
 */
export function groupEdgeChains(edges: readonly IEdge[]): IEdge[][] {
    const ends = edges.map((edge) => edge.ends());
    const parent = edges.map((_, index) => index);
    const root = (index: number): number => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
            if (touches(ends[i], ends[j])) parent[root(j)] = root(i);
        }
    }
    const chains = new Map<number, IEdge[]>();
    for (const [index, edge] of edges.entries()) {
        const key = root(index);
        const chain = chains.get(key);
        if (chain) chain.push(edge);
        else chains.set(key, [edge]);
    }
    return [...chains.values()];
}

function touches(a: readonly XYZ[], b: readonly XYZ[]): boolean {
    return a.some((p) => b.some((q) => p.distanceTo(q) < Precision.Distance));
}

/**
 * Turns one loft section into what the kernel lofts through: a vertex or wire as is, an
 * edge as a one-edge wire, a face as its outer wire, and a compound (e.g. a sketch's loose
 * edges) as the wire of its single, non-branching edge chain. Open chains are valid
 * sections; shells and solids are refused (their faces share edges). `index` names the section in error messages.
 */
export function prepareLoftSection(
    section: IShape,
    index: number,
    wire: (edges: IEdge[]) => Result<IWire>,
): Result<IVertex | IWire> {
    switch (section.shapeType) {
        case ShapeTypes.vertex:
            return Result.ok(section as IVertex);
        case ShapeTypes.wire:
            return Result.ok(section as IWire);
        case ShapeTypes.edge: {
            const built = wire([section as IEdge]);
            return built.isOk ? built : Result.err(`Section ${index}: ${built.error}`);
        }
        case ShapeTypes.face:
            return Result.ok((section as IFace).outerWire());
        case ShapeTypes.compound:
            return chainSection(section, index, wire);
        default:
            return Result.err(
                `Section ${index} is a ${ShapeTypeUtils.stringValue(section.shapeType)}; a loft section must be a vertex, edge, wire, face or compound of edges`,
            );
    }
}

function chainSection(
    section: IShape,
    index: number,
    wire: (edges: IEdge[]) => Result<IWire>,
): Result<IVertex | IWire> {
    const edges = section.findSubShapes(ShapeTypes.edge) as IEdge[];
    if (edges.length === 0) {
        const vertices = section.findSubShapes(ShapeTypes.vertex) as IVertex[];
        if (vertices.length === 1) return Result.ok(vertices[0]);
        return Result.err(
            `Section ${index} has no edges and ${vertices.length} vertices; a vertex section must be a single point`,
        );
    }
    const chains = groupEdgeChains(edges);
    if (chains.length > 1) {
        return Result.err(
            `Section ${index} has ${chains.length} separate edge chains; pick one with findSubShapes + wire`,
        );
    }
    if (hasBranchVertex(chains[0])) {
        return Result.err(
            `Section ${index} has a branching vertex (three or more edges meet at one point); pick one chain with findSubShapes + wire`,
        );
    }
    const built = wire(chains[0]);
    if (!built.isOk) return Result.err(`Section ${index}: ${built.error}`);
    return built;
}

/** True when more than two edge ends of `edges` coincide at one point (a figure-eight or T-junction). */
function hasBranchVertex(edges: readonly IEdge[]): boolean {
    const points = edges.flatMap((edge) => edge.ends());
    return points.some((p) => points.filter((q) => p.distanceTo(q) < Precision.Distance).length > 2);
}
