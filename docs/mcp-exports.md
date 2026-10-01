# Saving large MCP exports

`export_nodes` supports `delivery: "chunks"` for client-side file saving without putting file bytes into model context. Its result contains only metadata: `exportId`, `filename`, `mimeType`, `bytes`, `sha256`, `triangles` for STL, `chunkBytes` and `expiresInSeconds`, plus the existing node/output metadata. It supports merged CAD/mesh files and separate exports packaged as ZIP.

The default and maximum chunked export size is 32 MiB (`maxBytes` can lower it). The page retains at most 64 MiB across exports. Exports belong to the calling MCP session, expire after 10 minutes, and are removed on disconnect or explicit release. Re-export after expiry, reconnect, or page reload. No export is persisted in a document or browser storage.

`read_export_chunk` takes `exportId`, a decoded-byte `offset` (default 0), and `length` (default/maximum 49,152). It returns `offset`, `bytes`, `eof`, `encoding: "base64"` and `data`. Relay limits can shorten a response, so advance by the returned `bytes`, rather than by the requested length. Repeated range reads return the same bytes. An offset at the file size returns an empty EOF response; offsets outside the file are errors. `release: true` deletes an export without returning file bytes.

Run retrieval in a client script that owns the MCP connection. Decode directly into a local file, keep the chunks out of the model's conversation, and return only the filename/size/hash to the agent. A model calling the chunk tool repeatedly and reading its results still consumes context.

For example, with an already connected MCP SDK `Client` named `client`:

```js
import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse(result.content[0].text);
    if (result.isError || value.error) throw new Error(value.error ?? "MCP call failed");
    return value;
}

async function saveExport(path, ids, format = ".stl binary") {
    const metadata = await call("export_nodes", { ids, format, delivery: "chunks" });
    let file;
    try {
        // Choose the local path in the client; never treat a document's filename as a path.
        file = await open(path, "wx");
        const hash = createHash("sha256");
        let offset = 0;
        let eof = false;
        while (!eof) {
            const chunk = await call("read_export_chunk", {
                exportId: metadata.exportId, offset, length: metadata.chunkBytes,
            });
            const bytes = Buffer.from(chunk.data, "base64");
            if (chunk.offset !== offset || bytes.length !== chunk.bytes ||
                (!chunk.eof && bytes.length === 0)) throw new Error("Invalid export range");
            await file.writeFile(bytes);
            hash.update(bytes);
            offset += bytes.length;
            eof = chunk.eof;
        }
        if (offset !== metadata.bytes || hash.digest("hex") !== metadata.sha256)
            throw new Error("Export size/hash mismatch");
        return { path, bytes: offset, sha256: metadata.sha256 };
    } catch (error) {
        if (file) {
            await file.close();
            file = undefined;
            await unlink(path);
        }
        throw error;
    } finally {
        await file?.close();
        await call("read_export_chunk", { exportId: metadata.exportId, release: true })
            .catch(() => undefined);
    }
}
```

Browser `download` remains the default. `base64` still returns inline bytes for small exports (default 1 MiB, maximum 8 MiB, additionally bounded by relay response limits).
