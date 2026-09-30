# MCP model export

`export_nodes` merges the requested nodes into one file. `delivery: "download"` (the default)
downloads it in the browser. `delivery: "base64"` returns `encoding`, `data`, `filename`,
`mimeType`, decoded `bytes` and the exported node ids. Decode `data` as ordinary base64 bytes;
STEP text is encoded as UTF-8, and binary formats retain their exact bytes.

The default decoded-byte limit is 1 MiB. `maxBytes` accepts an integer from 1 to 8 MiB; the
relay's response limit also applies after base64 expansion and JSON escaping. A file exceeding
either limit returns an error and size information without starting a download. For a larger
file, export fewer nodes or use browser download. No persistent resource or server upload is created.

`filename` is a basename, with the format extension appended when missing. Directory separators
and control characters are rejected. This browser tool cannot write to the caller's computer;
an agent receiving base64 may save those decoded bytes using its own filesystem capabilities.

Use `mode: "separate"` to export each requested node as its own file in one ZIP archive. The default
mode, `merged`, still exports one combined model. Archive delivery can be `download` (one browser
download) or `base64` with the same payload limits. `filename` names the archive, default `models.zip`.

Each archive file uses the model's name plus the selected format extension. Path separators and
control characters in model names become underscores; duplicate names, ignoring case, gain a
deterministic numeric suffix. The `outputs` array lists the node id, resulting filename, MIME type,
decoded file size or an individual error. Successful files remain available when another requested
node is missing or cannot export. If every output fails, the tool returns errors without an archive.
