// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Plane } from "@spicy3d/core";
import { type Camera, CanvasTexture, Group, Sprite, SpriteMaterial, SRGBColorSpace, Vector3 } from "three";
import { gridLabels } from "./gridLabels";

/** Screen-sized text at workplane depth, occluded by solids and blended under transparent faces. */
export class ThreeGridLabels extends Group {
    private readonly textures = new Map<string, CanvasTexture>();
    private color = "";

    update(camera: Camera, plane: Plane, width: number, height: number, color: string) {
        if (this.color !== color) {
            this.dispose();
            this.color = color;
        }
        const labels = gridLabels(camera, plane, width, height);
        while (this.children.length > labels.length) {
            const sprite = this.children.at(-1) as Sprite;
            sprite.material.dispose();
            this.remove(sprite);
        }
        const used = new Set<string>();
        labels.forEach((label, index) => {
            const texture = this.texture(label.text);
            if (!texture) return;
            used.add(label.text);
            let sprite = this.children[index] as Sprite | undefined;
            if (!sprite) {
                sprite = new Sprite(
                    new SpriteMaterial({ depthTest: true, depthWrite: false, opacity: 0.55 }),
                );
                // Section planes cut the model, not the grid's coordinate graduations.
                // Keep depth testing so the remaining model still occludes the text.
                sprite.material.onBeforeCompile = (shader) => {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        "#include <clipping_planes_fragment>",
                        "",
                    );
                };
                // Draw before transparent model faces, which then blend over the text.
                sprite.renderOrder = -1;
                sprite.raycast = () => {};
                this.add(sprite);
            }
            sprite.material.map = texture;
            sprite.center.set(label.axis === "x" ? 0.5 : 0, label.axis === "x" ? 1 : 0.5);
            const point = new Vector3((label.x / width) * 2 - 1, 1 - (label.y / height) * 2, label.z);
            sprite.position.copy(point).unproject(camera);
            const right = point.clone();
            right.x += (texture.image.width / 2 / width) * 2;
            right.unproject(camera);
            const up = point.clone();
            up.y += (texture.image.height / 2 / height) * 2;
            up.unproject(camera);
            sprite.scale.set(right.distanceTo(sprite.position), up.distanceTo(sprite.position), 1);
        });
        for (const [text, texture] of this.textures) {
            if (!used.has(text)) {
                texture.dispose();
                this.textures.delete(text);
            }
        }
    }

    private texture(text: string): CanvasTexture | undefined {
        const cached = this.textures.get(text);
        if (cached) return cached;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return undefined;
        context.font = "22px sans-serif";
        canvas.width = Math.ceil(context.measureText(text).width) + 4;
        canvas.height = 28;
        context.font = "22px sans-serif";
        context.fillStyle = this.color;
        context.textBaseline = "top";
        context.fillText(text, 2, 0);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        this.textures.set(text, texture);
        return texture;
    }

    dispose() {
        for (const child of this.children) (child as Sprite).material.dispose();
        this.clear();
        for (const texture of this.textures.values()) texture.dispose();
        this.textures.clear();
    }
}
