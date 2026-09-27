// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { VisualConfig, type VisualItemConfig } from "@spicy3d/core";
import {
    type Camera,
    Color,
    DoubleSide,
    Mesh,
    OrthographicCamera,
    PerspectiveCamera,
    PlaneGeometry,
    ShaderMaterial,
    Vector3,
} from "three";

const vertexShader = /* glsl */ `
varying vec3 vWorld;

void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// Adaptive grid on the XY plane. The spacing follows the on-screen size of a pixel, so
// the grid refines when zooming in and coarsens when zooming out, cross-fading between
// decades so that no level pops in. Lines are 1px wide, anti-aliased with fwidth.
const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uAxisXColor;
uniform vec3 uAxisYColor;
uniform float uMinorOpacity;
uniform float uMajorOpacity;
uniform float uBaseSpacing;
uniform float uMinPixels;
uniform bool uOrtho;
uniform vec3 uViewDir;

varying vec3 vWorld;

float gridLine(vec2 p, float spacing) {
    vec2 c = p / spacing;
    vec2 w = max(fwidth(c), vec2(1e-6));
    vec2 g = abs(fract(c - 0.5) - 0.5) / w;
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    // lines closer than a few pixels only produce moire, fade them out
    return line * (1.0 - smoothstep(0.2, 0.5, max(w.x, w.y)));
}

float axisLine(float v) {
    float w = max(fwidth(v), 1e-6);
    return 1.0 - min(abs(v) / (w * 1.5), 1.0);
}

void main() {
    vec2 p = vWorld.xy;
    vec2 fw = fwidth(p);
    float footprint = max(fw.x, fw.y);
    float lod = max(log(footprint * uMinPixels / uBaseSpacing) / log(10.0), 0.0);
    float level = floor(lod);
    float blend = fract(lod);

    float s0 = uBaseSpacing * pow(10.0, level);
    float s1 = s0 * 10.0;
    float s2 = s1 * 10.0;

    float a0 = gridLine(p, s0) * uMinorOpacity * (1.0 - smoothstep(0.0, 1.0, blend));
    float a1 = gridLine(p, s1) * mix(uMajorOpacity, uMinorOpacity, blend);
    float a2 = gridLine(p, s2) * uMajorOpacity * blend;
    float alpha = max(a0, max(a1, a2));
    vec3 color = uColor;

    float ax = axisLine(p.y);
    float ay = axisLine(p.x);
    if (ax > 0.0 || ay > 0.0) {
        color = mix(color, ax >= ay ? uAxisXColor : uAxisYColor, max(ax, ay));
        alpha = max(alpha, max(ax, ay) * 0.8);
    }

    // fade towards the horizon, where the plane is seen edge-on
    vec3 viewDir = uOrtho ? uViewDir : normalize(cameraPosition - vWorld);
    alpha *= smoothstep(0.0, 0.3, abs(viewDir.z));

    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
}
`;

function createUniforms() {
    return {
        uColor: { value: new Color(VisualConfig.gridColor) },
        uAxisXColor: { value: new Color(0xe0474c) },
        uAxisYColor: { value: new Color(0x4caf50) },
        uMinorOpacity: { value: 0.12 },
        uMajorOpacity: { value: 0.3 },
        uBaseSpacing: { value: 1 },
        uMinPixels: { value: 60 },
        uOrtho: { value: false },
        uViewDir: { value: new Vector3(0, 0, 1) },
    };
}

export class ThreeGrid extends Mesh<PlaneGeometry, ShaderMaterial> {
    private readonly _viewDir = new Vector3();
    private readonly _uniforms: ReturnType<typeof createUniforms>;

    constructor() {
        const uniforms = createUniforms();
        super(
            new PlaneGeometry(1, 1),
            new ShaderMaterial({
                vertexShader,
                fragmentShader,
                uniforms,
                transparent: true,
                depthWrite: false,
                side: DoubleSide,
                // push the grid behind geometry lying on the XY plane
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
            }),
        );
        this._uniforms = uniforms;
        this.name = "grid";
        this.frustumCulled = false;
        this.renderOrder = -1;
        VisualConfig.onPropertyChanged(this.onVisualConfigChanged);
    }

    private readonly onVisualConfigChanged = (property: keyof VisualItemConfig) => {
        if (property === "gridColor") {
            this._uniforms.uColor.value.set(VisualConfig.gridColor);
        }
    };

    // the grid is decoration: never hit by picking
    override raycast() {}

    // the scene is shared by every view, so follow whichever camera is rendering
    override onBeforeRender(_renderer: unknown, _scene: unknown, camera: Camera) {
        let size = 1000;
        if (camera instanceof PerspectiveCamera) {
            size = camera.far * 2;
        } else if (camera instanceof OrthographicCamera) {
            const extent = Math.max(camera.right - camera.left, camera.top - camera.bottom) / camera.zoom;
            size = Math.max(camera.far, extent) * 2;
        }
        this.position.set(camera.position.x, camera.position.y, 0);
        this.scale.set(size, size, 1);
        this.updateMatrixWorld();

        const uniforms = this._uniforms;
        uniforms.uOrtho.value = camera instanceof OrthographicCamera;
        uniforms.uViewDir.value.copy(camera.getWorldDirection(this._viewDir).negate());
    }

    dispose() {
        VisualConfig.removePropertyChanged(this.onVisualConfigChanged);
        this.geometry.dispose();
        this.material.dispose();
    }
}
