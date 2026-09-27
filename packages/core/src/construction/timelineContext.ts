// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";

interface ActiveFeature {
    bodyId: string;
    index: number;
}
const active = new WeakMap<IDocument, ActiveFeature[]>();

/** Makes source resolution aware of the feature currently being evaluated. */
export function withConstructionFeaturePosition<T>(
    document: IDocument,
    bodyId: string,
    index: number,
    action: () => T,
): T {
    const stack = active.get(document) ?? [];
    stack.push({ bodyId, index });
    active.set(document, stack);
    try {
        return action();
    } finally {
        stack.pop();
        if (stack.length === 0) active.delete(document);
    }
}

export function activeConstructionFeature(document: IDocument, bodyId: string): ActiveFeature | undefined {
    return active.get(document)?.findLast((entry) => entry.bodyId === bodyId);
}

export function isConstructionFeatureActive(document: IDocument): boolean {
    return (active.get(document)?.length ?? 0) > 0;
}
