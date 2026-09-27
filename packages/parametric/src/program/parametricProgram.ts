// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    ConstructionNode,
    type ConstructionRef,
    type FeatureItem,
    type IDocument,
    Id,
    type IEdge,
    type IFace,
    type INode,
    LENGTH_UNITS,
    Matrix4,
    type ParameterValue,
    Plane,
    resolveUnitSpec,
    type Scope,
    ShapeNode,
    ShapeTypes,
    type UnitSpec,
    type XYZLike,
} from "@spicy3d/core";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { captureEdgeRef } from "../features/edgeRef";
import type {
    BooleanOperation,
    ExtrudeFeatureData,
    FeatureData,
    RevolveFeatureData,
} from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { captureFaceBoundaryRefs } from "../sketch/commands/sketchCommands";
import { captureFaceRef, type PlaneFaceRef, sketchPlaneOfFace } from "../sketch/planeRef";
import { type ExternalRefData, emptySketchData, type SketchData } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import {
    type ConstructionProgramHost,
    describeConstructionGeometry,
    resolveConstructionAxisRef,
    resolveConstructionPlaneRef,
    toConstructionDefinition,
} from "./constructionProgram";
import {
    describeSketch,
    type SketchAction,
    type SketchConstraintSpec,
    type SketchEntitySpec,
    type SketchNames,
    type SketchProgramHost,
    type SketchReport,
    SketchSession,
} from "./sketchProgram";

/**
 * A parametric program: an ordered list of sketch and feature operations, driven from a
 * plain-JSON payload. The engine owns no geometry of its own — every step delegates to
 * the same API the interactive commands use (`SketchSolver`, `SketchNode`,
 * `ParametricBodyNode.setFeaturesEmitShapeChanged`), so an AI-built body is
 * indistinguishable from a hand-built one.
 *
 * Contract: synchronous, and **throws on any failure** so the caller's `Transaction`
 * rolls the whole program back. Nothing is written to history and the visual is not
 * refreshed here — that is the caller's job.
 */

export type ParametricOp =
    | SketchOp
    | EditSketchOp
    | SketchInfoOp
    | ConstructOp
    | EditConstructionOp
    | ConstructionInfoOp
    | ExtrudeOp
    | RevolveOp
    | FilletChamferOp
    | BooleanOp
    | EditFeatureOp
    | FeaturesOp;

export interface SketchOp {
    op: "sketch";
    id: string;
    name?: string;
    /**
     * A datum plane, a planar face of an existing node, or a construction plane (a UCS
     * plane with `member`). Defaults to XY.
     */
    plane?:
        | "XY"
        | "YZ"
        | "ZX"
        | { nodeId: string; faceIndex: number }
        | { construction: string; member?: "XY" | "YZ" | "ZX" };
    /** Entity ids are their 1-based position here. */
    entities?: SketchEntitySpec[];
    constraints?: SketchConstraintSpec[];
    /** Editing actions applied after the entities and constraints (see `SketchAction`). */
    actions?: SketchAction[];
}

/** Applies editing actions to an existing sketch (or one built earlier in the program). */
export interface EditSketchOp {
    op: "editSketch";
    id?: string;
    sketch: string;
    actions: SketchAction[];
}

/** Reads a sketch back: entities, constraints, externals and solver status. */
export interface SketchInfoOp {
    op: "sketchInfo";
    id?: string;
    sketch: string;
}

/** Creates a construction plane, axis, point or UCS from a `ConstructionDefinition`. */
export interface ConstructOp {
    op: "construct";
    id: string;
    name?: string;
    definition: Record<string, unknown>;
    displaySize?: number;
}

export interface EditConstructionOp {
    op: "editConstruction";
    node: string;
    definition?: Record<string, unknown>;
    name?: string;
    displaySize?: number;
}

export interface ConstructionInfoOp {
    op: "constructionInfo";
    id?: string;
    node: string;
}

export interface ExtrudeOp {
    op: "extrude";
    id: string;
    name?: string;
    /** The sketch op id, or an existing sketch's node id. */
    sketch: string;
    depth: ParameterValue;
    symmetric?: boolean;
    startOffset?: ParameterValue;
    /** Omit to create a new body; otherwise the body to append the feature to. */
    body?: string;
    operation?: BooleanOperation;
}

export interface RevolveOp {
    op: "revolve";
    id: string;
    name?: string;
    sketch: string;
    /**
     * A fixed world axis, a construction axis (a UCS axis with `member`), or a linear
     * edge of a node — both references follow their source on rebuild.
     */
    axis:
        | { point: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }
        | { construction: string; member?: "X" | "Y" | "Z" }
        | { nodeId: string; edgeIndex: number };
    /** Degrees. Defaults to 360. Always starts a new body — revolve has no join/cut form. */
    angle?: ParameterValue;
}

export interface FilletChamferOp {
    op: "fillet" | "chamfer";
    id: string;
    name?: string;
    body: string;
    /** Indexes into the body's current edge list (findSubShapes order). */
    edgeIndexes: number[];
    radius?: ParameterValue;
    distance?: ParameterValue;
}

export interface BooleanOp {
    op: "boolean";
    id: string;
    name?: string;
    body: string;
    operation: BooleanOperation;
    /** Node ids (or op ids) of the tool bodies. */
    tools: string[];
    consumeTools?: boolean;
}

export interface EditFeatureOp {
    op: "editFeature";
    body: string;
    featureId: string;
    action: "setParameter" | "rename" | "suppress" | "moveTo" | "remove";
    key?: string;
    value?: ParameterValue | boolean;
    index?: number;
}

export interface FeaturesOp {
    op: "features";
    id?: string;
    body: string;
}

/**
 * A feature row as it leaves the engine. `FeatureItem` cannot be returned as-is: its
 * `references` hold live `INode`s, which own their parent and document right back, so
 * serializing it throws "cyclic structures". Everything here is plain data.
 */
export interface FeatureSummary {
    id: string;
    type: string;
    display: string;
    name?: string;
    suppressed: boolean;
    error?: string;
    warning?: string;
    reselectable?: boolean;
    references: { key: string; display: string; nodeId: string }[];
    parameters: { key: string; display: string; value: number | string | boolean; unit?: UnitSpec }[];
}

/** What one program produced, in the same envelope shape `run_program` uses. */
export interface ProgramResult {
    created: { id: string; nodeId: string; name: string }[];
    /** The feature list of every body the program touched. */
    bodies: { nodeId: string; name: string; features: FeatureSummary[] }[];
    /** Nodes adopted by a boolean feature — hidden children of the body, not deleted. */
    consumed: { nodeId: string; name: string; ownerId: string }[];
    results: Record<string, unknown>;
}

interface State {
    readonly document: IDocument;
    readonly refs: Map<string, string>;
    readonly out: ProgramResult;
    readonly touched: Set<ParametricBodyNode>;
    /** Entity/constraint names given in this program, per sketch node id. */
    readonly sketchNames: Map<string, SketchNames>;
}

/**
 * Op id -> node id, per document. Only node ids are kept: a node survives rebuilds and
 * undo/redo, so a stale entry resolves to "node not found" on its own — no live-shape
 * cache and therefore no rollback patching.
 */
const refsByDocument = new WeakMap<IDocument, Map<string, string>>();
const MAX_REFS_PER_DOCUMENT = 512;

function refsFor(document: IDocument): Map<string, string> {
    const existing = refsByDocument.get(document);
    if (existing !== undefined) return existing;
    const refs = new Map<string, string>();
    refsByDocument.set(document, refs);
    return refs;
}

/** Runs every op in order, returning the result envelope. Throws on the first failure. */
export function runParametricProgram(document: IDocument, ops: readonly ParametricOp[]): ProgramResult {
    const refs = refsFor(document);
    if (refs.size > MAX_REFS_PER_DOCUMENT) refs.clear();
    const state: State = {
        document,
        refs,
        out: { created: [], bodies: [], consumed: [], results: {} },
        touched: new Set(),
        sketchNames: new Map(),
    };
    ops.forEach((op, index) => {
        try {
            runOp(state, op);
        } catch (err) {
            throw new Error(`op ${index} ("${op.op}") failed: ${(err as Error).message}`);
        }
    });
    state.out.bodies = [...state.touched].map((body) => ({
        nodeId: body.id,
        name: body.name,
        features: summarizeFeatures(body),
    }));
    return state.out;
}

function runOp(state: State, op: ParametricOp): void {
    switch (op.op) {
        case "sketch":
            runSketchOp(state, op);
            break;
        case "editSketch":
            runEditSketchOp(state, op);
            break;
        case "sketchInfo":
            state.out.results[op.id ?? "sketchInfo"] = describeSketch(
                resolveSketch(state, op.sketch),
                state.document.variables.evaluate().scope,
            );
            break;
        case "construct":
            runConstructOp(state, op);
            break;
        case "editConstruction":
            runEditConstructionOp(state, op);
            break;
        case "constructionInfo":
            state.out.results[op.id ?? "constructionInfo"] = describeConstruction(
                resolveConstruction(state, op.node),
            );
            break;
        case "extrude":
            runExtrudeOp(state, op);
            break;
        case "revolve":
            runRevolveOp(state, op);
            break;
        case "fillet":
        case "chamfer":
            runEdgeCornerOp(state, op);
            break;
        case "boolean":
            runBooleanOp(state, op);
            break;
        case "editFeature":
            runEditFeatureOp(state, op);
            break;
        case "features":
            runFeaturesOp(state, op);
            break;
        default:
            throw new Error(`unknown op "${(op as { op: string }).op}"`);
    }
}

// ------------------------------------------------------------------ Reference resolution

/** Resolves an op id (or a plain node id) to a node. */
function resolveNode(state: State, ref: unknown, what: string): INode {
    const key = String(ref ?? "");
    if (key === "") throw new Error(`${what} is required`);
    const id = state.refs.get(key) ?? key;
    const node = state.document.modelManager.findNodes((n) => n.id === id)[0];
    if (node === undefined) {
        const known = state.refs.size > 0 ? [...state.refs.keys()].join(", ") : "none defined yet";
        throw new Error(
            `unknown ${what} "${key}": no node with id "${id}" (op ids defined in this session: ${known})`,
        );
    }
    return node;
}

function resolveSketch(state: State, ref: unknown): SketchNode {
    const node = resolveNode(state, ref, "sketch");
    if (!(node instanceof SketchNode)) {
        throw new Error(`"${ref}" is a ${node.constructor.name}, not a sketch`);
    }
    return node;
}

function resolveBody(state: State, ref: unknown): ParametricBodyNode {
    const node = resolveNode(state, ref, "body");
    if (!(node instanceof ParametricBodyNode)) {
        throw new Error(`"${ref}" is a ${node.constructor.name}, not a parametric body`);
    }
    return node;
}

// ------------------------------------------------------------------ Sketch

function runSketchOp(state: State, op: SketchOp): void {
    const { planeRef, plane, refPositions, externalRefs, constructionPlaneRef } = resolveSketchPlane(
        state,
        op,
    );
    const data: SketchData = emptySketchData();
    if (refPositions !== undefined) data.refPositions = refPositions;
    if (externalRefs !== undefined) {
        data.externalRefs = externalRefs;
        // the boundary refs were numbered down from the first external id before any
        // solver existed — persist the counter, as the interactive create does
        data.externalIdSeq = Math.min(...externalRefs.map((ref) => ref.entityId)) - 1;
    }

    const sketch = new SketchNode({ document: state.document, plane, planeRef, constructionPlaneRef, data });
    state.document.modelManager.addNode(sketch);
    if (op.name !== undefined) sketch.name = op.name;
    state.refs.set(op.id, sketch.id);
    state.out.created.push({ id: op.id, nodeId: sketch.id, name: sketch.name });

    const actions: SketchAction[] = [
        { action: "add", entities: op.entities ?? [], constraints: op.constraints ?? [] },
        ...(op.actions ?? []),
    ];
    state.out.results[op.id] = editSketch(state, sketch, actions);
}

function runEditSketchOp(state: State, op: EditSketchOp): void {
    if (!Array.isArray(op.actions) || op.actions.length === 0) {
        throw new Error('"editSketch" requires a non-empty "actions" array');
    }
    const sketch = resolveSketch(state, op.sketch);
    state.out.results[op.id ?? sketch.id] = editSketch(state, sketch, op.actions);
}

/** One solver session over the sketch; the solved data is stored only when every action succeeded. */
function editSketch(state: State, sketch: SketchNode, actions: readonly SketchAction[]): SketchReport {
    let names = state.sketchNames.get(sketch.id);
    if (names === undefined) {
        names = { entities: new Map(), constraints: new Map() };
        state.sketchNames.set(sketch.id, names);
    }
    const scope = state.document.variables.evaluate().scope;
    const session = new SketchSession(programHost(state), sketch, names, scope);
    try {
        session.run(actions);
        const { data, report } = session.finish();
        sketch.setDataEmitShapeChanged(data);
        // The node builds its edges lazily and reports failure only through `shape` — this
        // read is both the trigger and the single place a bad sketch can be caught.
        const shape = sketch.shape;
        if (!shape.isOk) throw new Error(`the sketch is not usable: ${shape.error}`);
        return report;
    } finally {
        session.dispose();
    }
}

/** The node lookups the sketch and construction halves of the engine share. */
function programHost(state: State): SketchProgramHost & ConstructionProgramHost {
    return {
        document: state.document,
        resolveNode: (ref, what) => resolveNode(state, ref, what),
        resolveSketch: (ref) => resolveSketch(state, ref),
    };
}

interface ResolvedSketchPlane {
    plane: Plane;
    planeRef?: PlaneFaceRef;
    refPositions?: Record<string, number>;
    externalRefs?: ExternalRefData[];
    constructionPlaneRef?: ConstructionRef;
}

function resolveSketchPlane(state: State, op: SketchOp): ResolvedSketchPlane {
    const picked = op.plane;
    if (picked === undefined || picked === "XY") return { plane: Plane.XY };
    if (picked === "YZ") return { plane: Plane.YZ };
    if (picked === "ZX") return { plane: Plane.ZX };
    if (typeof picked === "object" && "construction" in picked) {
        const { ref, plane } = resolveConstructionPlaneRef(programHost(state), picked);
        return { plane, constructionPlaneRef: ref };
    }

    const host = resolveNode(state, picked.nodeId, "plane host");
    if (!(host instanceof ShapeNode) || !host.shape.isOk) {
        throw new Error(`node "${picked.nodeId}" has no valid shape to build a sketch plane on`);
    }
    const faces = host.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const local = faces[picked.faceIndex];
    if (local === undefined) {
        throw new Error(
            `faceIndex ${picked.faceIndex} is out of range on "${picked.nodeId}" (0..${faces.length - 1})`,
        );
    }
    if (!local.surface().isPlanar()) {
        throw new Error(`face ${picked.faceIndex} of "${picked.nodeId}" is not planar`);
    }
    // Sketch planes and face refs are captured in world coordinates (planeRef.ts).
    const transform = host.worldTransform();
    const isIdentity = transform.equals(Matrix4.identity());
    const world = isIdentity ? local : (local.transformedMul(transform) as IFace);
    try {
        const planeRef = captureFaceRef(host.id, world);
        if (isBodyTrackingNode(host)) {
            const faceId = host.faceIdAt(picked.faceIndex);
            if (faceId !== undefined) planeRef.faceId = faceId;
        }
        // The plane belongs to the host's shape at capture time: anchor the sketch's
        // timeline there so a later feature moving the face does not drag the plane.
        const refPositions =
            host instanceof ParametricBodyNode ? { [host.id]: host.features.length } : undefined;
        const plane = sketchPlaneOfFace(world);
        // The face's boundary edges become reference-role externals, as in the interactive create.
        const externalRefs = captureFaceBoundaryRefs(host, local, transform, plane);
        return { plane, planeRef, refPositions, externalRefs };
    } finally {
        if (!isIdentity) world.dispose();
    }
}

// ------------------------------------------------------------------ Construction geometry

function runConstructOp(state: State, op: ConstructOp): void {
    const id = Id.generate();
    const definition = toConstructionDefinition(programHost(state), op.definition, id);
    const node = new ConstructionNode({
        document: state.document,
        id,
        definition,
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.displaySize !== undefined ? { displaySize: op.displaySize } : {}),
    });
    state.document.modelManager.addNode(node);
    const geometry = node.geometry;
    if (!geometry.isOk) throw new Error(`the construction does not evaluate: ${geometry.error}`);
    state.refs.set(op.id, node.id);
    state.out.created.push({ id: op.id, nodeId: node.id, name: node.name });
    state.out.results[op.id] = describeConstruction(node);
}

function runEditConstructionOp(state: State, op: EditConstructionOp): void {
    const node = resolveConstruction(state, op.node);
    if (op.definition !== undefined) {
        // The setter only toasts an invalid definition — validate here so the program fails.
        node.definition = toConstructionDefinition(programHost(state), op.definition, node.id);
        const geometry = node.geometry;
        if (!geometry.isOk) throw new Error(`the construction does not evaluate: ${geometry.error}`);
    }
    if (op.name !== undefined) node.name = op.name;
    if (op.displaySize !== undefined) node.displaySize = op.displaySize;
    state.out.results[op.node] = describeConstruction(node);
}

function resolveConstruction(state: State, ref: unknown): ConstructionNode {
    const node = resolveNode(state, ref, "construction");
    if (!(node instanceof ConstructionNode)) {
        throw new Error(`"${ref}" is a ${node.constructor.name}, not a construction node`);
    }
    return node;
}

function describeConstruction(node: ConstructionNode) {
    const geometry = node.geometry;
    return {
        nodeId: node.id,
        name: node.name,
        definition: node.definition,
        ...(geometry.isOk
            ? { geometry: describeConstructionGeometry(geometry.value) }
            : { error: geometry.error }),
    };
}

// ------------------------------------------------------------------ Features

function runExtrudeOp(state: State, op: ExtrudeOp): void {
    const sketch = resolveSketch(state, op.sketch);
    const scope = state.document.variables.evaluate().scope;
    ensureUnit(op.depth, scope, LENGTH_UNITS, "depth");
    if (op.startOffset !== undefined) ensureUnit(op.startOffset, scope, LENGTH_UNITS, "startOffset");

    // `profiles` is deliberately left out: an absent list extrudes every closed profile
    // of the sketch, which is what a whole-sketch extrude means.
    const feature: ExtrudeFeatureData = {
        id: Id.generate(),
        type: "extrude",
        sketchId: sketch.id,
        depth: op.depth,
        ...(op.symmetric === true ? { symmetric: true } : {}),
        ...(op.startOffset !== undefined ? { startOffset: op.startOffset } : {}),
    };
    if (op.body === undefined) {
        createBody(state, op.id, op.name, [feature], () => {
            sketch.visible = false;
        });
        return;
    }
    if (op.operation === undefined) {
        throw new Error('appending an extrude to an existing body requires "operation" (fuse/cut/common)');
    }
    const body = resolveBody(state, op.body);
    appendFeature(state, body, { ...feature, operation: op.operation });
    // An op that edits a body is registered as another name for it, so a later op can
    // reference the result of this one the same way it references a freshly built body.
    state.refs.set(op.id, body.id);
}

function runRevolveOp(state: State, op: RevolveOp): void {
    const sketch = resolveSketch(state, op.sketch);
    const scope = state.document.variables.evaluate().scope;
    if (op.angle !== undefined) ensureUnit(op.angle, scope, ANGLE_UNITS, "angle");

    const feature: RevolveFeatureData = {
        id: Id.generate(),
        type: "revolve",
        sketchId: sketch.id,
        ...revolveAxis(state, op.axis),
        angle: op.angle ?? 360,
    };
    createBody(state, op.id, op.name, [feature], () => {
        sketch.visible = false;
    });
}

function runEdgeCornerOp(state: State, op: FilletChamferOp): void {
    const body = resolveBody(state, op.body);
    const shape = body.shape;
    if (!shape.isOk) throw new Error(`body "${op.body}" has no valid shape: ${shape.error}`);
    const scope = state.document.variables.evaluate().scope;
    const value = op.op === "fillet" ? op.radius : op.distance;
    if (value === undefined)
        throw new Error(`"${op.op}" requires "${op.op === "fillet" ? "radius" : "distance"}"`);
    ensureUnit(value, scope, LENGTH_UNITS, op.op === "fillet" ? "radius" : "distance");

    const edges = shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const refs = op.edgeIndexes.map((index) => {
        const edge = edges[index];
        if (edge === undefined) {
            throw new Error(
                `edgeIndex ${index} is out of range on body "${op.body}" (0..${edges.length - 1})`,
            );
        }
        // Same capture the interactive fillet uses: the tracked id is what makes the
        // ref survive a rebuild, the fingerprint is what matches when it does not.
        const id = body.edgeIdAt(index);
        return captureEdgeRef(edge, id, body.edgeIdIsShared(id));
    });

    const feature: FeatureData =
        op.op === "fillet"
            ? { id: Id.generate(), type: "fillet", radius: value, edges: refs }
            : { id: Id.generate(), type: "chamfer", distance: value, edges: refs };
    appendFeature(state, body, feature);
    state.refs.set(op.id, body.id);
}

function runBooleanOp(state: State, op: BooleanOp): void {
    const body = resolveBody(state, op.body);
    const tools = op.tools.map((tool) => resolveNode(state, tool, "boolean tool"));
    for (const tool of tools) {
        if (tool.id === body.id) throw new Error(`cannot use the body "${op.body}" as its own boolean tool`);
        if (!(tool instanceof ShapeNode)) {
            throw new Error(`boolean tool "${tool.name}" is a ${tool.constructor.name}, not a shape node`);
        }
    }
    appendFeature(state, body, {
        id: Id.generate(),
        type: "boolean",
        operation: op.operation,
        toolIds: tools.map((tool) => tool.id),
        ...(op.consumeTools === false ? { consumeTools: false } : {}),
    });
    // The body adopts the tools itself (`syncConsumedTools`); this only reports it.
    for (const tool of tools) {
        state.out.consumed.push({ nodeId: tool.id, name: tool.name, ownerId: body.id });
    }
    state.refs.set(op.id, body.id);
}

function runEditFeatureOp(state: State, op: EditFeatureOp): void {
    const body = resolveBody(state, op.body);
    const before = erroredFeatureIds(body);
    switch (op.action) {
        case "setParameter":
            if (op.key === undefined) throw new Error('"setParameter" requires "key"');
            if (op.value === undefined) throw new Error('"setParameter" requires "value"');
            body.setFeatureParameter(op.featureId, op.key, op.value);
            break;
        case "rename":
            body.renameFeature(op.featureId, typeof op.value === "string" ? op.value : "");
            return;
        case "suppress":
            body.setFeatureSuppressed(op.featureId, op.value === true);
            break;
        case "moveTo":
            if (typeof op.index !== "number") throw new Error('"moveTo" requires a numeric "index"');
            body.moveFeatureTo(op.featureId, op.index);
            break;
        case "remove":
            body.removeFeature(op.featureId);
            break;
        default:
            throw new Error(`unknown editFeature action "${(op as { action: string }).action}"`);
    }
    checkBody(state, body, before);
}

function runFeaturesOp(state: State, op: FeaturesOp): void {
    state.out.results[op.id ?? "features"] = summarizeFeatures(resolveBody(state, op.body));
}

/** Feature rows stripped of their live nodes — see `FeatureSummary`. */
function summarizeFeatures(body: ParametricBodyNode): FeatureSummary[] {
    const types = body.features.map((feature) => feature.type);
    return body.featureItems().map((item, index) => featureSummary(item, types[index]));
}

function featureSummary(item: FeatureItem, type: string | undefined): FeatureSummary {
    const summary: FeatureSummary = {
        id: item.id,
        type: type ?? "unknown",
        display: item.display,
        suppressed: item.suppressed === true,
        references: (item.references ?? []).map((reference) => ({
            key: reference.key,
            display: reference.display,
            // The node itself is what cycles — keep its id, which is what a caller needs.
            nodeId: reference.node.id,
        })),
        parameters: item.parameters.map((parameter) => ({
            key: parameter.key,
            display: parameter.display,
            value: parameter.value,
            ...(parameter.unit !== undefined ? { unit: parameter.unit } : {}),
        })),
    };
    if (item.name !== undefined) summary.name = item.name;
    if (item.error !== undefined) summary.error = item.error;
    if (item.warning !== undefined) summary.warning = item.warning;
    if (item.reselectable === true) summary.reselectable = true;
    return summary;
}

// ------------------------------------------------------------------ Feature plumbing

function createBody(
    state: State,
    id: string,
    name: string | undefined,
    features: FeatureData[],
    afterAdd?: () => void,
): void {
    const body = new ParametricBodyNode({ document: state.document, features });
    state.document.modelManager.addNode(body);
    if (name !== undefined) body.name = name;
    afterAdd?.();
    checkBody(state, body, undefined);
    state.refs.set(id, body.id);
    state.out.created.push({ id, nodeId: body.id, name: body.name });
}

/**
 * The single write gate for features. A failed rebuild is swallowed by the node — it
 * keeps the previous shape and only records the message on the feature row — so this
 * has to compare before and after and raise, or a broken model would be reported as a
 * success. Only *new* errors count: a stale failure from an earlier edit must not make
 * every later op look broken.
 */
function appendFeature(state: State, body: ParametricBodyNode, feature: FeatureData): void {
    const before = erroredFeatureIds(body);
    body.setFeaturesEmitShapeChanged([...body.features, feature]);
    checkBody(state, body, before);
}

function checkBody(state: State, body: ParametricBodyNode, before: Set<string> | undefined): void {
    const failed = body
        .featureItems()
        .find((item) => item.error !== undefined && (before === undefined || !before.has(item.id)));
    if (failed !== undefined) {
        throw new Error(`feature "${failed.display}" (${failed.id}) failed: ${failed.error}`);
    }
    const shape = body.shape;
    if (!shape.isOk) throw new Error(`the body could not be rebuilt: ${shape.error}`);
    state.touched.add(body);
}

function erroredFeatureIds(body: ParametricBodyNode): Set<string> {
    return new Set(
        body
            .featureItems()
            .filter((item) => item.error !== undefined)
            .map((item) => item.id),
    );
}

/** Resolves a parameter up front so a bad expression fails here, not inside a rebuild. */
function ensureUnit(value: ParameterValue, scope: Scope, expected: UnitSpec, what: string): void {
    const resolved = resolveUnitSpec(value, scope, expected);
    if (!resolved.isOk) throw new Error(`"${what}" is not usable: ${resolved.error}`);
}

type FixedAxis = Extract<RevolveOp["axis"], { point: unknown }>;

/**
 * The revolve axis: always a world-space snapshot (what the handler falls back to), plus
 * the live reference a construction axis or a picked edge contributes.
 */
function revolveAxis(
    state: State,
    axis: RevolveOp["axis"],
): Pick<RevolveFeatureData, "axis" | "axisSource" | "constructionAxisRef"> {
    const plain = (v: XYZLike) => ({ x: v.x, y: v.y, z: v.z });
    if (axis !== null && typeof axis === "object" && "construction" in axis) {
        const { ref, point, direction } = resolveConstructionAxisRef(programHost(state), axis);
        return { axis: { point: plain(point), direction: plain(direction) }, constructionAxisRef: ref };
    }
    if (axis !== null && typeof axis === "object" && "nodeId" in axis) {
        const node = resolveNode(state, axis.nodeId, "axis node");
        if (!(node instanceof ShapeNode) || !node.shape.isOk) {
            throw new Error(`node "${axis.nodeId}" has no valid shape to take an axis edge from`);
        }
        const edges = node.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const edge = edges[axis.edgeIndex];
        if (edge === undefined) {
            throw new Error(
                `edgeIndex ${axis.edgeIndex} is out of range on "${axis.nodeId}" (0..${edges.length - 1})`,
            );
        }
        const transform = node.worldTransform();
        const start = transform.ofPoint(edge.startPoint());
        const direction = transform.ofPoint(edge.endPoint()).sub(start).normalize();
        if (direction === undefined) throw new Error(`edge ${axis.edgeIndex} is degenerate`);
        const edgeId = isBodyTrackingNode(node) ? node.edgeIdAt(axis.edgeIndex) : undefined;
        return {
            axis: { point: plain(start), direction: plain(direction) },
            // local coordinates, as the interactive pick stores it; re-matched on every rebuild
            axisSource: { nodeId: node.id, edge: captureEdgeRef(edge, edgeId) },
        };
    }
    ensureAxis(axis);
    return { axis: { point: { ...axis.point }, direction: { ...axis.direction } } };
}

function ensureAxis(axis: unknown): asserts axis is FixedAxis {
    const finite = (v: { x: number; y: number; z: number } | undefined) =>
        v !== undefined && [v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n));
    const candidate = axis as Partial<FixedAxis> | undefined;
    if (!finite(candidate?.point) || !finite(candidate?.direction)) {
        throw new Error(
            '"axis" must be { point: {x,y,z}, direction: {x,y,z} }, { construction, member? } or { nodeId, edgeIndex }',
        );
    }
    const { x, y, z } = candidate!.direction!;
    if (x === 0 && y === 0 && z === 0) throw new Error('"axis.direction" must be non-zero');
}
