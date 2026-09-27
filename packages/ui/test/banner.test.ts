// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";

rs.mock("../src/banner/banner.module.css", () => ({
    host: "banner-host",
    banner: "banner-banner",
    info: "banner-info",
    warn: "banner-warn",
    error: "banner-error",
    message: "banner-message",
    action: "banner-action",
    close: "banner-close",
}));

import "./_helpers/mockCoreI18n";
import "./_helpers/mockElementRealEvents";

import { Banner } from "../src/banner";
import { mustQuery } from "./_helpers/domHelpers";

const banners = () => Array.from(document.querySelectorAll<HTMLElement>(".banner-banner"));

describe("Banner", () => {
    afterEach(() => {
        for (const banner of banners()) Banner.hide(banner.getAttribute("data-banner-id") ?? "");
    });

    test("shows a translated, non-modal status message at the top of the window", () => {
        Banner.show({ id: "a", level: "warn", message: "cloud.banner.appOutdated" });

        const banner = mustQuery<HTMLElement>(document, ".banner-host > .banner-banner");
        expect(banner.classList.contains("banner-warn")).toBe(true);
        expect(banner.getAttribute("role")).toBe("status");
        expect(mustQuery(banner, ".banner-message").textContent).toBe("cloud.banner.appOutdated");
        expect(document.querySelector("dialog")).toBeNull();
    });

    test("the action button runs the action and keeps the banner", () => {
        const run = rs.fn(() => {});
        Banner.show({
            id: "a",
            level: "warn",
            message: "cloud.banner.appOutdated",
            action: { label: "common.reload", run },
        });

        const action = mustQuery<HTMLButtonElement>(document, ".banner-action");
        expect(action.textContent).toBe("common.reload");
        action.click();

        expect(run).toHaveBeenCalledTimes(1);
        expect(banners()).toHaveLength(1);
    });

    test("the close button removes the banner and its host", () => {
        Banner.show({ id: "a", level: "info", message: "cloud.banner.appOutdated" });

        mustQuery<HTMLButtonElement>(document, ".banner-close").click();

        expect(banners()).toHaveLength(0);
        expect(document.querySelector(".banner-host")).toBeNull();
    });

    test("a banner that isn't dismissible has no close button", () => {
        Banner.show({ id: "a", level: "error", message: "cloud.banner.serverOutdated", dismissible: false });

        expect(banners()).toHaveLength(1);
        expect(document.querySelector(".banner-close")).toBeNull();
    });

    test("showing the same id replaces the banner; other ids stack", () => {
        Banner.show({ id: "a", level: "info", message: "cloud.banner.appOutdated" });
        Banner.show({ id: "a", level: "warn", message: "cloud.banner.serverOutdated" });
        Banner.show({ id: "b", level: "info", message: "cloud.banner.appOutdated" });

        expect(banners().map((b) => b.getAttribute("data-banner-id"))).toEqual(["a", "b"]);
        expect(mustQuery(document, '[data-banner-id="a"] .banner-message').textContent).toBe(
            "cloud.banner.serverOutdated",
        );
    });

    test("hide removes only that banner", () => {
        Banner.show({ id: "a", level: "info", message: "cloud.banner.appOutdated" });
        Banner.show({ id: "b", level: "info", message: "cloud.banner.appOutdated" });

        Banner.hide("a");

        expect(banners().map((b) => b.getAttribute("data-banner-id"))).toEqual(["b"]);
    });
});
