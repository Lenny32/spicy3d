// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

async function getAllFiles(dirPath, basePath = dirPath) {
    const files = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
            const subFiles = await getAllFiles(fullPath, basePath);
            files.push(...subFiles);
        } else {
            files.push({ fullPath, relativePath });
        }
    }

    return files;
}

async function addFilesToZip(zip, fileList, basePath) {
    for (const filePath of fileList) {
        // Read first and fall back to a directory walk on EISDIR: a stat-then-read check could race.
        const content = await readFile(filePath).catch((error) => {
            if (error.code === "EISDIR") return undefined;
            throw error;
        });

        if (content === undefined) {
            const folderName = path.basename(filePath);
            const files = await getAllFiles(filePath, filePath);
            for (const file of files) {
                const fileContent = await readFile(file.fullPath);
                zip.file(`${folderName}/${file.relativePath}`, fileContent);
            }
        } else {
            const relativePath = path.relative(basePath, filePath);
            zip.file(relativePath, content);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error("Usage: node package-plugin.mjs <output.spicyplugin> <input1> [input2] ...");
        console.error("    input can be files or directories");
        process.exit(1);
    }

    const outputPath = args[0];
    const inputPaths = args.slice(1);
    const basePath = process.cwd();

    const zip = new JSZip();
    await addFilesToZip(zip, inputPaths, basePath);
    const content = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(outputPath, content);

    console.log(`Created ${outputPath} successfully`);
}

await main().catch(console.error);
