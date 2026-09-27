// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface Skill {
    name: string;
    description: string;
    /** Read when the tool is called, so a skill is free to assemble its content lazily. */
    content: string;
}
