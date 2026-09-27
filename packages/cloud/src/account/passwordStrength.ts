// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "@spicy3d/core";

/** The server's rules (NIST 800-63B): a minimum length and a common-password list, no composition rules. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordStrength = "tooShort" | "weak" | "fair" | "good" | "strong";

export interface PasswordStrengthHint {
    strength: PasswordStrength;
    /** 0 (too short) … 4 (strong), for the meter. */
    score: number;
    message: I18nKeys;
}

const MESSAGES: Record<PasswordStrength, I18nKeys> = {
    tooShort: "account.password.tooShort{0}",
    weak: "account.password.weak",
    fair: "account.password.fair",
    good: "account.password.good",
    strong: "account.password.strong",
};

/** Fragments of the most common passwords; the server's list is the authority, this only lowers the hint. */
const COMMON_FRAGMENTS = [
    "password",
    "passw0rd",
    "letmein",
    "welcome",
    "iloveyou",
    "admin",
    "spicy3d",
    "monkey",
    "dragon",
];

const SEQUENCES = [
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "azertyuiop",
];

/** Length of the password once runs of a repeated character or of a keyboard/alphabet sequence count once. */
function effectiveLength(password: string): number {
    const lower = password.toLowerCase();
    let length = 0;
    for (let i = 0; i < lower.length; i++) {
        const previous = lower[i - 1];
        const current = lower[i];
        const repeated = current === previous;
        const inSequence =
            previous !== undefined &&
            SEQUENCES.some((sequence) => {
                const at = sequence.indexOf(previous);
                return at >= 0 && (sequence[at + 1] === current || sequence[at - 1] === current);
            });
        if (!repeated && !inSequence) length++;
    }
    return length;
}

function alphabetSize(password: string): number {
    let size = 0;
    if (/[a-z]/.test(password)) size += 26;
    if (/[A-Z]/.test(password)) size += 26;
    if (/\d/.test(password)) size += 10;
    if (/[^a-zA-Z\d\s]/.test(password)) size += 33;
    if (/\s/.test(password)) size += 1;
    // Anything beyond ASCII (accents, other scripts) widens the alphabet a lot.
    if (/\P{ASCII}/u.test(password)) size += 100;
    return Math.max(size, 1);
}

/**
 * A rough strength hint while typing: estimated bits from the alphabet and the length, with repeats,
 * sequences ("abcd", "1234", "qwerty") and the user's own email or name discounted. Only a hint: the
 * server decides (length, common-password list).
 */
export function estimatePasswordStrength(password: string, personal: string[] = []): PasswordStrengthHint {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return { strength: "tooShort", score: 0, message: MESSAGES.tooShort };
    }

    let text = password;
    for (const fragment of COMMON_FRAGMENTS) text = text.replace(new RegExp(fragment, "gi"), "x");
    for (const word of personal.flatMap((p) => p.toLowerCase().split(/[@.\s_+-]+/))) {
        if (word.length >= 3) text = text.replace(new RegExp(word.replace(/\W/g, "\\$&"), "gi"), "");
    }
    const bits = effectiveLength(text) * Math.log2(alphabetSize(password));
    const strength: PasswordStrength =
        bits < 36 ? "weak" : bits < 55 ? "fair" : bits < 75 ? "good" : "strong";
    const score = { weak: 1, fair: 2, good: 3, strong: 4 }[strength];
    return { strength, score, message: MESSAGES[strength] };
}
