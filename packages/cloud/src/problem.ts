// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@spicy3d/core";

/**
 * The stable `code` of a server problem (SpicySrv `ProblemCodes`). The server never changes an
 * existing value; a code this client doesn't know yet falls back to the default code of its status.
 */
export const PROBLEM_MESSAGES = {
    // Defaults by status.
    bad_request: "error.cloud.badRequest",
    unauthorized: "error.cloud.unauthorized",
    forbidden: "error.cloud.forbidden",
    not_found: "error.cloud.notFound",
    method_not_allowed: "error.cloud.badRequest",
    conflict: "error.cloud.conflict",
    precondition_failed: "error.cloud.preconditionFailed",
    precondition_required: "error.cloud.preconditionRequired",
    payload_too_large: "error.cloud.payloadTooLarge",
    validation_failed: "error.cloud.validationFailed",
    too_many_requests: "error.cloud.tooManyRequests",
    internal_error: "error.cloud.internalError",
    service_unavailable: "error.cloud.serviceUnavailable",
    // Accounts and authentication.
    csrf_failed: "error.cloud.csrfFailed",
    signup_disabled: "error.cloud.signupDisabled",
    email_taken: "error.cloud.emailTaken",
    invalid_credentials: "error.cloud.invalidCredentials",
    invalid_password: "error.cloud.invalidPassword",
    account_locked: "error.cloud.accountLocked",
    account_disabled: "error.cloud.accountDisabled",
    invalid_token: "error.cloud.invalidToken",
    email_disabled: "error.cloud.emailDisabled",
    cannot_target_self: "error.cloud.cannotTargetSelf",
    too_many_tokens: "error.cloud.tooManyTokens",
    // Documents, versions and blobs.
    document_exists: "error.cloud.documentExists",
    version_conflict: "error.cloud.versionConflict",
    document_in_trash: "error.cloud.documentInTrash",
    blobs_missing: "error.cloud.blobsMissing",
    hash_mismatch: "error.cloud.hashMismatch",
    quota_exceeded: "error.cloud.quotaExceeded",
    idempotency_key_reused: "error.cloud.idempotencyKeyReused",
} as const satisfies Record<string, I18nKeys>;

export type ProblemCode = keyof typeof PROBLEM_MESSAGES;

/** The per-field codes of a `validation_failed` problem's `errors` map. */
export const FIELD_MESSAGES = {
    client_id_too_long: "error.cloud.field.clientIdTooLong",
    device_name_too_long: "error.cloud.field.deviceNameTooLong",
    display_name_required: "error.cloud.field.displayNameRequired",
    display_name_too_long: "error.cloud.field.displayNameTooLong",
    duplicate_email: "error.cloud.emailTaken",
    email_required: "error.cloud.field.emailRequired",
    email_too_long: "error.cloud.field.emailTooLong",
    head_not_parent: "error.cloud.field.headNotParent",
    invalid_cursor: "error.cloud.field.invalidCursor",
    invalid_display_name: "error.cloud.field.invalidDisplayName",
    invalid_email: "error.cloud.field.invalidEmail",
    invalid_expiry: "error.cloud.field.invalidExpiry",
    invalid_interval: "error.cloud.field.invalidInterval",
    invalid_label: "error.cloud.field.invalidLabel",
    invalid_name: "error.cloud.field.invalidName",
    label_too_long: "error.cloud.field.labelTooLong",
    manifest_too_large: "error.cloud.field.manifestTooLarge",
    name_required: "error.cloud.field.nameRequired",
    name_too_long: "error.cloud.field.nameTooLong",
    password_common: "error.cloud.field.passwordCommon",
    password_too_long: "error.cloud.field.passwordTooLong",
    password_too_short: "error.cloud.field.passwordTooShort",
    query_too_long: "error.cloud.field.queryTooLong",
    scopes_required: "error.cloud.field.scopesRequired",
    too_many_blobs: "error.cloud.field.tooManyBlobs",
    unknown_scope: "error.cloud.field.unknownScope",
} as const satisfies Record<string, I18nKeys>;

/**
 * An RFC 9457 problem as SpicySrv sends it. The OpenAPI `ProblemDetails` schema doesn't declare the
 * extension members (`code`, `traceId`, …; SpicySrv#9), so they are typed by hand here.
 */
export interface CloudProblem {
    type?: string | null;
    title?: string | null;
    status?: number | null;
    detail?: string | null;
    instance?: string | null;
    /** Stable snake_case code; filled in from the status when the body has none. */
    code: string;
    traceId?: string;
    /** `validation_failed`: camelCase field name → stable snake_case codes. */
    errors?: Record<string, string[]>;
    /** `blobs_missing`: the SHA-256 of every blob still to upload. */
    missing?: string[];
    /** `version_conflict`: the current head the save must fast-forward or merge onto. */
    headVersionId?: string;
    headCreatedAt?: string;
    headDeviceName?: string | null;
}

/** Why a server call failed; every expected failure is one of these (never a throw). */
export type CloudError =
    /** No answer: offline, DNS, connection refused, CORS. */
    | { kind: "offline" }
    /** Cancelled through the request's `AbortSignal`. */
    | { kind: "aborted" }
    /** An answer this client can't read, e.g. HTML from a proxy instead of JSON. */
    | { kind: "invalidResponse" }
    /** An HTTP error status, with the server's problem details (synthesized from the status if absent). */
    | { kind: "problem"; status: number; problem: CloudProblem; retryAfterSeconds?: number };

/**
 * The code for a status when a problem carries none: SpicySrv's `ProblemCodes.ForStatus`, except
 * that 507 (only answered on uploads over the quota) reads as `quota_exceeded`.
 */
export function codeForStatus(status: number): ProblemCode {
    switch (status) {
        case 400:
            return "bad_request";
        case 401:
            return "unauthorized";
        case 403:
            return "forbidden";
        case 404:
            return "not_found";
        case 405:
            return "method_not_allowed";
        case 409:
            return "conflict";
        case 412:
            return "precondition_failed";
        case 413:
            return "payload_too_large";
        case 422:
            return "validation_failed";
        case 428:
            return "precondition_required";
        case 429:
            return "too_many_requests";
        case 503:
            return "service_unavailable";
        case 507:
            return "quota_exceeded";
        default:
            return status >= 500 ? "internal_error" : "bad_request";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrays(value: unknown): Record<string, string[]> | undefined {
    if (!isRecord(value)) return undefined;
    const result: Record<string, string[]> = {};
    for (const [field, codes] of Object.entries(value)) {
        if (Array.isArray(codes)) result[field] = codes.filter((c): c is string => typeof c === "string");
    }
    return result;
}

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Reads an error body into a problem; anything unreadable becomes the status' default problem. */
export function toProblem(status: number, body: unknown): CloudProblem {
    const raw: { readonly [K in keyof CloudProblem]?: unknown } = isRecord(body) ? body : {};
    const problem: CloudProblem = {
        type: optionalString(raw.type),
        title: optionalString(raw.title),
        status: typeof raw.status === "number" ? raw.status : status,
        detail: optionalString(raw.detail),
        instance: optionalString(raw.instance),
        code: optionalString(raw.code) ?? codeForStatus(status),
        traceId: optionalString(raw.traceId),
        errors: stringArrays(raw.errors),
        missing: Array.isArray(raw.missing)
            ? raw.missing.filter((m): m is string => typeof m === "string")
            : undefined,
        headVersionId: optionalString(raw.headVersionId),
        headCreatedAt: optionalString(raw.headCreatedAt),
        headDeviceName: optionalString(raw.headDeviceName),
    };
    for (const key of Object.keys(problem) as (keyof CloudProblem)[]) {
        if (problem[key] === undefined) delete problem[key];
    }
    return problem;
}

/** The problem code of an error (`undefined` when the server never answered). */
export function problemCode(error: CloudError): string | undefined {
    return error.kind === "problem" ? error.problem.code : undefined;
}

/** The i18n key of an error's message; an unknown code gets the generic message of its status. */
export function cloudErrorMessageKey(error: CloudError): I18nKeys {
    switch (error.kind) {
        case "offline":
            return "error.cloud.offline";
        case "aborted":
            return "error.cloud.aborted";
        case "invalidResponse":
            return "error.cloud.invalidResponse";
        case "problem":
            return Object.hasOwn(PROBLEM_MESSAGES, error.problem.code)
                ? PROBLEM_MESSAGES[error.problem.code as ProblemCode]
                : PROBLEM_MESSAGES[codeForStatus(error.status)];
    }
}

/** A translatable message: an i18n key and the arguments of its `{0}` placeholders. */
export interface CloudErrorMessage {
    key: I18nKeys;
    args: unknown[];
}

/**
 * The message of an error with its arguments. A rate limit (429) that says when to come back
 * (`Retry-After`) reads "try again in N minutes" instead of the generic "wait a moment".
 */
export function describeCloudError(error: CloudError): CloudErrorMessage {
    if (error.kind === "problem" && error.status === 429 && error.retryAfterSeconds !== undefined) {
        const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
        return minutes === 1
            ? { key: "error.cloud.retryInAMinute", args: [] }
            : { key: "error.cloud.retryInMinutes{0}", args: [minutes] };
    }
    return { key: cloudErrorMessageKey(error), args: [] };
}

/** The translated message of an error, for a toast or an inline hint. */
export function cloudErrorMessage(error: CloudError): string {
    const { key, args } = describeCloudError(error);
    return I18n.translate(key, ...args);
}

/** The i18n key of one field code of a `validation_failed` problem; unknown codes get a generic one. */
export function fieldErrorMessageKey(code: string): I18nKeys {
    return Object.hasOwn(FIELD_MESSAGES, code)
        ? FIELD_MESSAGES[code as keyof typeof FIELD_MESSAGES]
        : "error.cloud.field.invalid";
}

/** `validation_failed` errors as translated messages per field (empty for any other error). */
export function fieldErrorMessages(error: CloudError): Record<string, string[]> {
    if (error.kind !== "problem" || !error.problem.errors) return {};
    return Object.fromEntries(
        Object.entries(error.problem.errors).map(([field, codes]) => [
            field,
            codes.map((code) => I18n.translate(fieldErrorMessageKey(code))),
        ]),
    );
}
