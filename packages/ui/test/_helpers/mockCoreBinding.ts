// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@spicy3d/core` mock for the tree item tests: no-op Binding,
// immediate Transaction. Lives in a helper module instead of inline in the test
// files so those tests can import `@spicy3d/core/test-utils` FIRST — inline
// `rs.mock` calls are hoisted above the imports and would feed test-utils a
// half-initialized core namespace.
// Import this module BEFORE the module under test (but AFTER the test-utils import).

import { rs } from "@rstest/core";

rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const {
        BindingMock,
        FolderNodeMock,
        TransactionMock,
        I18nMock,
        isFeatureListNodeMock,
        isNodeIconMock,
        isNodeWarningMock,
    } = rs.hoisted(() => require("./coreMocks"));
    return {
        ...actual,
        AnalysisNode: class AnalysisNode {},
        ShapeNode: class ShapeNode {},
        MeshNode: class MeshNode {},
        Binding: BindingMock,
        Transaction: TransactionMock,
        FolderNode: FolderNodeMock,
        I18n: I18nMock,
        isFeatureListNode: isFeatureListNodeMock,
        isNodeIcon: isNodeIconMock,
        isNodeWarning: isNodeWarningMock,
    };
});
