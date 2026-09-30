# Bounded MCP geometry execution (#96)

Runtime-only extension of the existing hybrid worker. The serialized document, feature payloads,
and module versions are unchanged. This implements phase 1 of KERNEL-01; parametric worker
booleans retain their deployment opt-in.

## Runtime bridge

`IShapeFactory.boundedOperations` exposes the same lazy `HybridShapeFactory` instance used by
`asyncOperations` when enabled. MCP direct programs use the bounded bridge independently of
parametric deployment settings. A whitelist defines each operation and its typed wire arguments:
boolean fuse/cut/common (including fuse simplification), fillet/chamfer, loft, and thick-solid simple/join.
Curve/surface query operations, including wire/face offsets, retain their synchronous ordered path.
Worker requests contain BREP snapshots plus topology descriptions, numbers/enums, and validated
subshape indexes. Native handles never cross realms. Imported inputs and outputs must match their
snapshot topology. Selected opening faces must resolve to verified input-face indexes.

## Bounds and recovery

Every worker request has a finite deadline of 90 seconds, below the relay's 120-second deadline.
A deadline terminates the entire worker generation, settles its outstanding requests, removes
listeners/timers, and invalidates resident leases. A following operation lazily creates a fresh
worker. A timeout/unavailable worker is an operation error, never a synchronous retry of the
expensive geometry on the main thread. Timeout does not mark the main kernel crashed. Main-kernel
recovery (#98) and live progress (#92) remain separate. Strict in-flight abort terminates its
worker generation as described in [cancellation](kernel-cancellation.md).

## Program consistency and responsive reads

Programs await eligible operations inside `Transaction.executeAsync`; all mutation tools remain
in the page's shared FIFO queue. Only the built-in metadata readers `get_document_state` and
`get_selection` may bypass that queue. While a program is open these readers and the document
resource report a captured committed-state snapshot, rather than intermediate nodes or refs.
No geometry inspections bypass the queue.

A runtime document mutation guard blocks new UI commands and mutation transactions while an MCP
program yields; autosave/sync holds remain active until commit/rollback. Worker results are
installed before subsequent program operations, preserving op order, node-consumption rules, and
existing cross-call reference semantics. On failure, rollback restores nodes/history plus the exact
pre-call ref/null registries, including overwritten IDs and registry insertion order.

## Validation

Tests cover deadline termination, rejection of stale replies, release of timers/listeners, lazy
worker recreation, real-kernel operation parity, selected-face correspondence, and no synchronous
fallback. MCP integration tests hold a worker operation pending and require status reads to resolve
while a second mutation remains queued. Program timeout tests verify exact rollback and successful
reuse of previously committed references. UI tests require new mutation commands to be blocked.
