// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CloudConnection } from "../cloud";
import { AccountSettingsSections } from "../ui/accountSettings";
import { autosaveSection } from "./autosaveSection";
import { CloudUserSettings, type CloudUserSettingsOptions } from "./userSettings";

export * from "./autosaveSection";
export * from "./userSettings";

/**
 * Keeps the user's settings (the autosave interval) on the server while signed in, and adds the
 * autosave section to the account settings. Returns the teardown.
 */
export function startCloudSettings(
    connection: CloudConnection,
    options?: CloudUserSettingsOptions,
): () => void {
    const settings = new CloudUserSettings(connection.account, options);
    const section = autosaveSection(settings);
    AccountSettingsSections.push(section);
    return () => {
        settings.dispose();
        const index = AccountSettingsSections.indexOf(section);
        if (index >= 0) AccountSettingsSections.splice(index, 1);
    };
}
