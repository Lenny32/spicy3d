// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { AnalysisAppearance } from "@spicy3d/core";
import { DoubleSide, type Material, MeshLambertMaterial, ShaderMaterial } from "three";

/** Procedural studio environment, bundled as project code (AGPL-3.0). */
export function createAnalysisMaterial(appearance: AnalysisAppearance): Material {
    if (appearance.mode === "color") {
        return new MeshLambertMaterial({ color: appearance.color ?? 0x7799cc, side: DoubleSide });
    }
    const zebra = appearance.mode === "zebra";
    const rotation = zebra ? (appearance.direction ?? 0) : (appearance.rotation ?? 0);
    const density = Math.max(1, Math.min(80, appearance.density ?? 12));
    const contrast = Math.max(0, Math.min(1, appearance.contrast ?? 0.8));
    const finish = Math.max(0, Math.min(1, appearance.mirrorFinish ?? 0.8));
    return new ShaderMaterial({
        side: DoubleSide,
        clipping: true,
        uniforms: {
            uRotation: { value: (rotation * Math.PI) / 180 },
            uDensity: { value: density },
            uContrast: { value: contrast },
            uFinish: { value: finish },
            uSoftbox: { value: appearance.environment === "softbox" ? 1 : 0 },
            uZebra: { value: zebra ? 1 : 0 },
        },
        vertexShader: `
            #include <clipping_planes_pars_vertex>
            varying vec3 vNormal;
            varying vec3 vEye;
            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vNormal = normalize(normalMatrix * normal);
                vEye = normalize(mvPosition.xyz);
                gl_Position = projectionMatrix * mvPosition;
                #include <clipping_planes_vertex>
            }
        `,
        fragmentShader: `
            #include <clipping_planes_pars_fragment>
            varying vec3 vNormal;
            varying vec3 vEye;
            uniform float uRotation;
            uniform float uDensity;
            uniform float uContrast;
            uniform float uFinish;
            uniform int uSoftbox;
            uniform int uZebra;
            void main() {
                #include <clipping_planes_fragment>
                vec3 reflected = reflect(vEye, normalize(vNormal));
                float coordinate = dot(reflected, vec3(cos(uRotation), sin(uRotation), 0.48));
                if (uZebra == 1) {
                    float stripe = sin(coordinate * uDensity * 6.2831853);
                    float width = max(0.025, fwidth(stripe));
                    float black = smoothstep(-width, width, stripe);
                    float level = mix(0.5, black, uContrast);
                    gl_FragColor = vec4(vec3(level), 1.0);
                } else {
                    float band = sin(coordinate * (uSoftbox == 1 ? 9.0 : 17.0));
                    float gloss = smoothstep(0.75 - (1.0 - uFinish) * 0.6,
                        0.75 + max(0.02, (1.0 - uFinish) * 0.25), band);
                    float level = mix(0.28, 0.96, gloss);
                    gl_FragColor = vec4(vec3(level), 1.0);
                }
            }
        `,
    });
}
