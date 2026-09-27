// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage, Observable } from "@spicy3d/core";

const STORAGE_KEY = "cloud.device";

interface StoredDeviceSettings {
    keepOfflineCopies?: boolean;
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

    private read(): StoredDeviceSettings {
        try {
            return this.storage.value<StoredDeviceSettings>(STORAGE_KEY, {}) ?? {};
        } catch {
            return {};
        }
    }

    private write() {
        this.storage.setValue(STORAGE_KEY, { keepOfflineCopies: this.keepOfflineCopies });
    }
}
