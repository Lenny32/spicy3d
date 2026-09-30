// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Eligibility of an existing tracking identity for associative consumers. The producer must
 * still prove ancestry: this predicate only prevents explicitly untracked or authored-only
 * tokens from masquerading as reusable topology identity, including merged ancestor leaves.
 */
export function isReusableTopologyIdentity(id: string | undefined): id is string {
    return (
        id
            ?.split("|")
            .every(
                (leaf) => leaf.length > 0 && !leaf.startsWith("untracked:") && !leaf.startsWith("path-ref:"),
            ) === true
    );
}
