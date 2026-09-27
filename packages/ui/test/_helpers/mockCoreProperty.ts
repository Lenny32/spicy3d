// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@spicy3d/core` mock used by the property tests:
// Localize/Binding/PathBinding/Transaction/ObservableCollection stubs plus a
// no-op PubSub. `isPropertyChanged` is stubbed to false because the real
// implementation loops over prototypes (`while (isPropertyChanged(proto))` in
// property/input.ts); `XY`/`XYZ` are stubbed with same-named classes because
// property/input.ts only uses them as converter-map keys (`XYZ.name`).
// Import this module BEFORE the module under test.

import { rs } from "@rstest/core";

rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const {
        LocalizeMock,
        BindingMock,
        PathBindingMock,
        TransactionMock,
        ObservableCollectionMock,
        PubSubMock,
        I18nMock,
        unitExportsMock,
    } = rs.hoisted(() => require("./coreMocks"));
    return {
        ...actual,
        ...unitExportsMock(),
        Localize: LocalizeMock,
        Binding: BindingMock,
        PathBinding: PathBindingMock,
        Transaction: TransactionMock,
        ObservableCollection: ObservableCollectionMock,
        PubSub: PubSubMock,
        I18n: I18nMock,
        isPropertyChanged: () => false,
        XY: class {},
        XYZ: class {},
    };
});
