// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DEFAULT_APP_URL, DEFAULT_PORT, parseOptions } from "../src/options.mjs";

describe("parseOptions", () => {
    test("defaults to the local dev server, port 7777 and a token to be generated", () => {
        const options = parseOptions([], {});

        expect(options).toMatchObject({
            appUrl: DEFAULT_APP_URL,
            port: DEFAULT_PORT,
            noToken: false,
            token: "",
        });
        expect([...options.allowedOrigins]).toEqual(["http://localhost:8080"]);
    });

    test("accepts a hosted page and allows only its origin", () => {
        const options = parseOptions(
            ["--app-url", "https://cad.example.com/app/", "-p", "9000", "-t", "s3cret"],
            {},
        );

        expect(options).toMatchObject({
            appUrl: "https://cad.example.com/app/",
            port: 9000,
            token: "s3cret",
        });
        expect([...options.allowedOrigins]).toEqual(["https://cad.example.com"]);
    });

    test("flags win over environment variables", () => {
        const env = {
            SPICY3D_APP_URL: "https://env.example/",
            SPICY3D_BRIDGE_PORT: "8000",
            SPICY3D_BRIDGE_TOKEN: "env",
        };

        expect(parseOptions(["-u", "https://flag.example/"], env)).toMatchObject({
            appUrl: "https://flag.example/",
            port: 8000,
            token: "env",
        });
    });

    test("no-token mode clears the token", () => {
        expect(parseOptions(["--no-token"], { SPICY3D_BRIDGE_TOKEN: "x" })).toMatchObject({
            noToken: true,
            token: "",
        });
        expect(parseOptions([], { SPICY3D_BRIDGE_NO_TOKEN: "1" })).toMatchObject({ noToken: true });
    });

    test("adds extra origins from flags and the environment", () => {
        const options = parseOptions(
            ["--allow-origin", "https://a.example/x", "--allow-origin", "https://b.example"],
            {
                SPICY3D_ALLOWED_ORIGINS: "https://c.example, ",
            },
        );

        expect([...options.allowedOrigins]).toEqual([
            "http://localhost:8080",
            "https://a.example",
            "https://b.example",
            "https://c.example",
        ]);
    });

    test.each([
        [["--app-url", "not a url"], "--app-url is not a valid URL"],
        [["--app-url", "ftp://x.example/"], "must be an http(s) address"],
        [["--port", "0"], "--port must be an integer"],
        [["--token", "a", "--no-token"], "cannot be used together"],
        [["--allow-origin", "nope"], "--allow-origin is not a valid URL"],
        [["--bogus"], "Unknown option"],
    ])("rejects %j", (argv, message) => {
        expect(() => parseOptions(argv, {})).toThrow(message);
    });
});
