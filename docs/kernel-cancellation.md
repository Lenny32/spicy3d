# Cancellation of bounded geometry (#97)

Strict `run_program` factory operations use the same hybrid worker as bounded execution.
The program signal is passed to `IBoundedShapeFactory.shapeOperation`; a pre-aborted signal
fails before replica capture or worker creation. The strict RPC uses `terminateOnAbort`,
which terminates its entire worker generation, settles all outstanding replies with
`cancelled`, clears timers/listeners, and invalidates resident leases. Native CPU work cannot
handle a posted cancellation message while running, so termination happens from the main realm.

Ordinary hybrid tracked operations keep logical cancellation and their existing late-result
ownership/profiling contract. The strict operation owns a linked signal listener only while
pending; completed, consumed, or cancelled operations detach it. A finished result wins over a
later abort. A pending program abort follows the existing scoped transaction rollback path,
restoring exact nodes, refs, and history before the mutation FIFO allows the next tool to start.
The next strict operation creates a fresh worker. A cancelled generation never marks the main
kernel failed; main-kernel recovery remains separate (#98). Saved formats are unchanged.

Tests include rapid abort and generation replacement, stale replies and old handle rejection,
listener cleanup and completion races, exact program rollback and FIFO reuse. Browser smoke
uses a separate test-only message port to announce entry into the real OCCT native operation
before aborting, so termination cannot merely kill worker initialization or queued work.
