// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import en from "@spicy3d/i18n/src/en";
import {
    type CloudError,
    cloudErrorMessage,
    cloudErrorMessageKey,
    codeForStatus,
    FIELD_MESSAGES,
    fieldErrorMessageKey,
    fieldErrorMessages,
    PROBLEM_MESSAGES,
    problemCode,
    toProblem,
} from "../src/problem";

const problem = (status: number, code: string): CloudError => ({
    kind: "problem",
    status,
    problem: { code },
});

describe("problem messages", () => {
    test.each([
        ["version_conflict", 409, "error.cloud.versionConflict"],
        ["invalid_credentials", 401, "error.cloud.invalidCredentials"],
        ["email_disabled", 503, "error.cloud.emailDisabled"],
        ["blobs_missing", 422, "error.cloud.blobsMissing"],
        ["too_many_tokens", 409, "error.cloud.tooManyTokens"],
        ["validation_failed", 422, "error.cloud.validationFailed"],
    ] as const)("%s maps to its own message", (code, status, key) => {
        expect(cloudErrorMessageKey(problem(status, code))).toBe(key);
    });

    test.each([
        [401, "error.cloud.unauthorized"],
        [403, "error.cloud.forbidden"],
        [404, "error.cloud.notFound"],
        [409, "error.cloud.conflict"],
        [418, "error.cloud.badRequest"],
        [429, "error.cloud.tooManyRequests"],
        [502, "error.cloud.internalError"],
        [503, "error.cloud.serviceUnavailable"],
        [507, "error.cloud.quotaExceeded"],
    ] as const)("an unknown code with status %i gets the generic message of the status", (status, key) => {
        expect(cloudErrorMessageKey(problem(status, "added_in_a_newer_server"))).toBe(key);
    });

    test("codes that collide with Object.prototype members are unknown codes", () => {
        expect(cloudErrorMessageKey(problem(404, "toString"))).toBe("error.cloud.notFound");
        expect(fieldErrorMessageKey("__proto__")).toBe("error.cloud.field.invalid");
    });

    test.each([
        [{ kind: "offline" }, "error.cloud.offline"],
        [{ kind: "aborted" }, "error.cloud.aborted"],
        [{ kind: "invalidResponse" }, "error.cloud.invalidResponse"],
    ] as const)("%j has a message", (error, key) => {
        expect(cloudErrorMessageKey(error)).toBe(key);
    });

    test("every mapped key has an English text", () => {
        const keys = [
            ...Object.values(PROBLEM_MESSAGES),
            ...Object.values(FIELD_MESSAGES),
            "error.cloud.field.invalid",
        ];
        for (const key of keys) {
            expect(en.translation[key as keyof typeof en.translation]).toEqual(expect.any(String));
        }
    });

    test("cloudErrorMessage translates the key (the test locale translates keys to themselves)", () => {
        expect(cloudErrorMessage(problem(401, "invalid_credentials"))).toBe("error.cloud.invalidCredentials");
        expect(cloudErrorMessage(problem(404, "added_in_a_newer_server"))).toBe("error.cloud.notFound");
    });

    test("problemCode is the problem's code, undefined without an answer", () => {
        expect(problemCode(problem(409, "version_conflict"))).toBe("version_conflict");
        expect(problemCode({ kind: "offline" })).toBeUndefined();
    });
});

describe("field messages", () => {
    test("validation codes map per field; unknown codes get the generic one", () => {
        const error: CloudError = {
            kind: "problem",
            status: 422,
            problem: { code: "validation_failed", errors: { name: ["name_too_long", "brand_new_rule"] } },
        };

        expect(fieldErrorMessages(error)).toEqual({
            name: ["error.cloud.field.nameTooLong", "error.cloud.field.invalid"],
        });
    });

    test("errors other than validation have no field messages", () => {
        expect(fieldErrorMessages({ kind: "offline" })).toEqual({});
        expect(fieldErrorMessages(problem(409, "version_conflict"))).toEqual({});
    });
});

describe("toProblem", () => {
    test("ignores members of the wrong type and fills the code from the status", () => {
        expect(
            toProblem(409, { code: 7, title: ["x"], traceId: "t", missing: ["a", 1], status: "409" }),
        ).toEqual({
            code: "conflict",
            status: 409,
            traceId: "t",
            missing: ["a"],
        });
    });

    test.each([null, "text", 42, [1]])("a body of %j is the status' default problem", (body) => {
        expect(toProblem(404, body)).toEqual({ code: "not_found", status: 404 });
    });

    test("codeForStatus mirrors the server's defaults", () => {
        expect(codeForStatus(400)).toBe("bad_request");
        expect(codeForStatus(412)).toBe("precondition_failed");
        expect(codeForStatus(428)).toBe("precondition_required");
        expect(codeForStatus(500)).toBe("internal_error");
    });
});
