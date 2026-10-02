# MCP node cleanup batches

`delete_node` and `set_node_visible` accept either `id` (the existing single-node API and response) or `ids` (a batch), never both. For example:

```json
{"ids": ["section-sketch-1", "section-sketch-2", "helper-body"]}
```

Pass this to `delete_node`, or add `"visible": false` for `set_node_visible`. `visible` must be a boolean; use `true` to show the nodes.

A batch accepts 1–100 non-empty string ids of at most 128 characters, bounding the per-id response for the relay. Invalid arguments change nothing. Calls use the existing serialized MCP tool queue.

All ids resolve against the document before editing. Missing ids are reported individually while valid targets are applied in one transaction and one undo step. A mutation failure rolls back the entire transaction and reports every valid target as failed. An all-missing batch creates no undo step. Duplicate ids are applied once but receive an entry for every occurrence.

Batch replies contain `results` in input order:

```json
{
  "error": "Some node ids failed; inspect results before retrying",
  "results": [
    {"id": "section-sketch-1", "deleted": "section-sketch-1"},
    {"id": "missing", "error": "node not found; call get_document_state for current ids"}
  ]
}
```

Visibility successes contain `{"id": "plane-1", "visible": false}` instead. Any failed entry adds a top-level `error`, which sets MCP `isError`; successful entries may still have been applied. Inspect the entries and retry only failures. Refresh ids with `get_document_state` when nodes have been consumed or deleted.

Deleting a folder removes its descendants too. If both a folder and its child are requested, both report success regardless of input order; undo restores the original hierarchy. Hiding a folder hides descendants through inherited visibility. Type and folder-content selectors are not provided; obtain ids from `get_document_state` or target the folder itself.
