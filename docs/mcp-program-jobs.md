# Runtime modeling jobs and rebuild status

`start_program_job` accepts the same `ops` as `run_program` plus optional `timeoutMs`.
It immediately returns a `jobId`, original `documentId`, state and operation progress.
`get_program_job { jobId }` reads the running job without entering the mutation queue.
`cancel_program_job { jobId }` requests cancellation through the same native worker
termination path as request cancellation. A running job stays `cancelling` until rollback
finishes; a queued job is cancelled before it performs any edits.

States: `queued`, `running`, `cancelling`, `completed`, `cancelled`, `failed`.
Progress counts completed operations, reports total operations and the current method.
It does not estimate progress inside an OCCT operation. Successful completion includes
the ordinary `run_program` result. Failed or cancelled jobs retain their error. An output
exceeding the reporting limit remains `completed` with a clear reporting error, because
the program has committed; inspect the document before deciding what to do next.

Every background mutation occupies the existing page FIFO until commit/rollback, including
ordinary calls and other connections. Only actual built-in status/control tools bypass it;
plugins cannot grant themselves this behavior by reusing a built-in name. Existing document
metadata readers show the committed snapshot while the transaction is open. Inputs are
copied at submission, and a queued job refuses to edit a different active document.

Jobs belong to their submitting MCP caller. Other sessions cannot inspect or cancel them.
Closing the connection, removing the relay agent or signing out cancels its outstanding jobs.
Jobs are runtime-only and do not add document fields, module versions, storage keys or requests.

Bounds: 1–256 operations, 1 MiB input, four active jobs per caller, sixteen retained jobs
per page, ten-minute completed retention, default 120-second deadline (queue wait included),
caller maximum 600 seconds. Worker requests retain their own 90-second upper bound. At
capacity, the oldest completed job may be discarded; active jobs are never silently evicted.
Result retention is limited to 1 MiB per job. There is no detached asynchronous `run_parametric`
mode in this change: that API still deliberately forces synchronous evaluation.

`get_rebuild_status` reports the active document's runtime pending background parametric
rebuild count and last yielded feature indexes, where known. It does not flush geometry,
start a rebuild, synthesize a percentage or change the worker opt-in policy. Status stays
observable during existing worker-backed rebuilds. Cheap construction/query operations
that still use the main kernel retain their synchronous limitations.
