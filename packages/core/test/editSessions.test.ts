// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { EditSessions, type IDocument } from "../src";

describe("EditSessions", () => {
    test("endAll ends every session of that document only; they unregister", () => {
        const a = {} as IDocument;
        const b = {} as IDocument;
        const releases: (() => void)[] = [];
        const endA = rs.fn(() => releases[0]());
        const endB = rs.fn(() => releases[1]());
        releases.push(EditSessions.begin(a, endA), EditSessions.begin(b, endB));

        EditSessions.endAll(a);

        expect(endA).toHaveBeenCalledTimes(1);
        expect(endB).not.toHaveBeenCalled();
        expect(EditSessions.isActive(a)).toBe(false);
        expect(EditSessions.isActive(b)).toBe(true);
        releases[1]();
        expect(EditSessions.isActive(b)).toBe(false);
    });
});
