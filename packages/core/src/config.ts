// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage, Observable } from "./foundation";
import { I18n } from "./i18n";
import type { Navigation3DType } from "./navigation";
import { type SerializedData, Serializer, serialize } from "./serialize";
import { type ObjectSnapType, ObjectSnapTypes, ObjectSnapTypeUtils } from "./snapType";

export const DefaultLightEdgeColor = 0x333333;
export const DefaultDarkEdgeColor = 0xeeeeee;
export const DefaultLightGridColor = 0x303030;
export const DefaultDarkGridColor = 0xd0d0d0;

export class VisualItemConfig extends Observable {
    defaultFaceColor = 0xdedede;
    profileFaceColor = 0x6fa8e0;
    highlightEdgeColor = 0x33ff33;
    highlightFaceColor = 0x99ff00;
    selectedEdgeColor = 0x33ff33;
    selectedFaceColor = 0x33ff33;
    editVertexSize = 7;
    editVertexColor = 0x33ff33;
    hintVertexSize = 5;
    hintVertexColor = 0x33ff33;
    trackingVertexSize = 7;
    trackingVertexColor = 0x33ff33;
    temporaryVertexSize = 5;
    temporaryVertexColor = 0x33ff33;
    temporaryEdgeColor = 0x33ff33;

    get defaultEdgeColor() {
        return this.getPrivateValue("defaultEdgeColor", DefaultLightEdgeColor);
    }
    set defaultEdgeColor(value: number) {
        this.setProperty("defaultEdgeColor", value);
    }

    get gridColor() {
        return this.getPrivateValue("gridColor", DefaultLightGridColor);
    }
    set gridColor(value: number) {
        this.setProperty("gridColor", value);
    }

    applyTheme(theme: "light" | "dark") {
        this.defaultEdgeColor = theme === "light" ? DefaultLightEdgeColor : DefaultDarkEdgeColor;
        this.gridColor = theme === "light" ? DefaultLightGridColor : DefaultDarkGridColor;
    }
}

export const VisualConfig = new VisualItemConfig();

export class Config extends Observable {
    static readonly #instance = new Config();

    static get instance() {
        return Config.#instance;
    }

    readonly SnapDistance: number = 10;

    get snapType() {
        return this.getPrivateValue(
            "snapType",
            ObjectSnapTypeUtils.combine(
                ObjectSnapTypes.midPoint,
                ObjectSnapTypes.endPoint,
                ObjectSnapTypes.center,
                ObjectSnapTypes.perpendicular,
                ObjectSnapTypes.intersection,
                ObjectSnapTypes.onCurve,
                ObjectSnapTypes.onSurface,
                ObjectSnapTypes.vertex,
                ObjectSnapTypes.tangent,
            ),
        );
    }
    set snapType(snapType: ObjectSnapType) {
        this.setProperty("snapType", snapType);
    }

    get enableSnapTracking() {
        return this.getPrivateValue("enableSnapTracking", true);
    }
    set enableSnapTracking(value: boolean) {
        this.setProperty("enableSnapTracking", value);
    }

    get enableSnap() {
        return this.getPrivateValue("enableSnap", true);
    }
    set enableSnap(value: boolean) {
        this.setProperty("enableSnap", value);
    }

    get dynamicWorkplane() {
        return this.getPrivateValue("dynamicWorkplane", true);
    }
    set dynamicWorkplane(value: boolean) {
        this.setProperty("dynamicWorkplane", value);
    }

    @serialize()
    get showGrid() {
        return this.getPrivateValue("showGrid", true);
    }
    set showGrid(value: boolean) {
        this.setProperty("showGrid", value);
    }

    @serialize()
    get language() {
        return this.getPrivateValue("language", I18n.defaultLanguage());
    }
    set language(value: string) {
        this.setProperty("language", value);
    }

    @serialize()
    get navigation3D() {
        return this.getPrivateValue("navigation3D", "Fusion360");
    }
    set navigation3D(value: Navigation3DType) {
        this.setProperty("navigation3D", value);
    }

    @serialize()
    get themeMode() {
        return this.getPrivateValue("themeMode", "system");
    }
    set themeMode(value: "light" | "dark" | "system") {
        this.setProperty("themeMode", value, () => this.applyTheme(value));
    }

    @serialize()
    get trustedDomains() {
        return this.getPrivateValue("trustedDomains", []);
    }
    set trustedDomains(value: string[]) {
        this.setProperty("trustedDomains", value);
    }

    #storageKey: string = "config";
    get storageKey() {
        return this.#storageKey;
    }

    private constructor() {
        super();
    }

    init(storageKey: string) {
        this.#storageKey = storageKey;
        this.readFromStorage();
        this.applyTheme(this.themeMode);
    }

    private readonly applyTheme = (value: "light" | "dark" | "system") => {
        if (value === "system") {
            VisualConfig.applyTheme(
                window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            );
        } else {
            VisualConfig.applyTheme(value);
        }
    };

    readFromStorage() {
        const data = ObjectStorage.default.value<SerializedData>(this.storageKey);
        for (const key in data) {
            const thisKey = key as keyof Config;
            this.setPrivateValue(thisKey, (data as any)[key]);
        }
    }

    saveToStorage() {
        const json = Serializer.serializeProperties(this);
        ObjectStorage.default.setValue(this.storageKey, json);
    }
}
