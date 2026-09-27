// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentLocation, ObjectStorage, Observable } from "@spicy3d/core";
import { describeUserAgent } from "./userAgent";

const STORAGE_KEY = "cloud.device";

/** The server keeps at most this many characters of a version's device name. */
export const DEVICE_NAME_MAX_LENGTH = 100;

interface StoredDeviceSettings {
    keepOfflineCopies?: boolean;
    deviceName?: string;
    newDocumentLocation?: DocumentLocation;
}

/** "Linux – Firefox" from the user agent; "This device" when nothing is recognizable. */
export function defaultDeviceName(userAgent: string | undefined = globalThis.navigator?.userAgent): string {
    const { browser, os } = describeUserAgent(userAgent);
    return [os, browser].filter(Boolean).join(" – ") || "This device";
}

/**
 * Cloud settings that belong to this browser, not to the account (so they stay in `localStorage`
 * and never go to the server). The autosave interval is an account setting (CLOUD-07).
 */
export class CloudDeviceSettings extends Observable {
    constructor(private readonly storage: ObjectStorage = ObjectStorage.default) {
        super();
        const stored = this.read();
        this.setPrivateValue("keepOfflineCopies", stored.keepOfflineCopies === true);
        this.setPrivateValue("deviceName", typeof stored.deviceName === "string" ? stored.deviceName : "");
        this.setPrivateValue(
            "newDocumentLocation",
            stored.newDocumentLocation === "local" ? "local" : "cloud",
        );
    }

    /**
     * Keep the cached copies of cloud documents on this device after signing out (off by default:
     * signing out removes them). Local documents are never removed either way.
     */
    get keepOfflineCopies(): boolean {
        return this.getPrivateValue("keepOfflineCopies", false);
    }
    set keepOfflineCopies(value: boolean) {
        this.setProperty("keepOfflineCopies", value, () => this.write());
    }

    /**
     * The name this browser gives itself in the version history ("Desktop – Firefox"), as the user
     * typed it; empty = {@link defaultDeviceName}. See {@link effectiveDeviceName}.
     */
    get deviceName(): string {
        return this.getPrivateValue("deviceName", "");
    }
    set deviceName(value: string) {
        this.setProperty("deviceName", value.trim().slice(0, DEVICE_NAME_MAX_LENGTH), () => this.write());
    }

    /** The name sent with every save. */
    get effectiveDeviceName(): string {
        return (this.deviceName || defaultDeviceName()).slice(0, DEVICE_NAME_MAX_LENGTH);
    }

    /** Where a new document is saved while signed in (the cloud by default). */
    get newDocumentLocation(): DocumentLocation {
        return this.getPrivateValue("newDocumentLocation", "cloud");
    }
    set newDocumentLocation(value: DocumentLocation) {
        this.setProperty("newDocumentLocation", value, () => this.write());
    }

    private read(): StoredDeviceSettings {
        try {
            return this.storage.value<StoredDeviceSettings>(STORAGE_KEY, {}) ?? {};
        } catch {
            return {};
        }
    }

    private write() {
        this.storage.setValue(STORAGE_KEY, {
            keepOfflineCopies: this.keepOfflineCopies,
            deviceName: this.deviceName,
            newDocumentLocation: this.newDocumentLocation,
        } satisfies StoredDeviceSettings);
    }
}
