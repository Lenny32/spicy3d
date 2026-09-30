// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMutations } from "../src";
import { TestDocument } from "../test-utils";

test("captured rebuild authority is document-local and restores nested synchronous authority", () => {
    const document = new TestDocument();
    const other = new TestDocument();
    const owner = DocumentMutations.hold(document);
    const otherOwner = DocumentMutations.hold(other);
    try {
        expect(DocumentMutations.captureScope(document)).toBeUndefined();
        const captured = owner.run(() => DocumentMutations.captureScope(document));
        expect(captured).toBe(owner);
        if (!captured) throw new Error("The active owner did not expose its scope");
        owner.run(() => {
            expect(DocumentMutations.captureScope(other)).toBeUndefined();
            otherOwner.run(() => {
                expect(DocumentMutations.captureScope(other)).toBe(otherOwner);
                expect(DocumentMutations.captureScope(document)).toBe(owner);
            });
            expect(DocumentMutations.captureScope(other)).toBeUndefined();
            expect(() => (other.modelManager.rootNode.name = "unauthorized")).toThrow("modeling program");
            captured.run(() => (document.modelManager.rootNode.name = "rebuilt"));
            expect(DocumentMutations.captureScope(document)).toBe(owner);
        });
        expect(document.modelManager.rootNode.name).toBe("rebuilt");
        expect(DocumentMutations.captureScope(document)).toBeUndefined();
        expect(() => (document.modelManager.rootNode.name = "external")).toThrow("modeling program");
    } finally {
        otherOwner.release();
        owner.release();
        other.dispose();
        document.dispose();
    }
});

test("resumed authority never leaks across awaits and cannot revive after release", async () => {
    const document = new TestDocument();
    const owner = DocumentMutations.hold(document);
    try {
        const captured = owner.run(() => DocumentMutations.captureScope(document));
        expect(captured).toBe(owner);
        if (!captured) throw new Error("The active owner did not expose its scope");
        await captured.run(async () => {
            document.modelManager.rootNode.name = "before await";
            await Promise.resolve();
            expect(DocumentMutations.captureScope(document)).toBeUndefined();
            expect(() => (document.modelManager.rootNode.name = "leaked")).toThrow("modeling program");
            captured.run(() => (document.modelManager.rootNode.name = "resumed"));
        });
        expect(document.modelManager.rootNode.name).toBe("resumed");
        expect(DocumentMutations.captureScope(document)).toBeUndefined();
        expect(() =>
            captured.run(() => {
                throw new Error("callback failed");
            }),
        ).toThrow("callback failed");
        expect(() => (document.modelManager.rootNode.name = "after exception")).toThrow("modeling program");
        owner.release();
        const replacement = DocumentMutations.hold(document);
        try {
            expect(() => captured.run(() => (document.modelManager.rootNode.name = "stale"))).toThrow(
                "released",
            );
            expect(document.modelManager.rootNode.name).toBe("resumed");
            replacement.run(() => (document.modelManager.rootNode.name = "new owner"));
            expect(document.modelManager.rootNode.name).toBe("new owner");
        } finally {
            replacement.release();
        }
    } finally {
        owner.release();
        document.dispose();
    }
});
