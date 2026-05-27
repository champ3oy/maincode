# Two-phase commit history load

The History tab walks every ancestor of HEAD — potentially 100k+ commits. Sending the full row payload `{oid, parents, refs, subject, body, author, email, timestamp, …}` for every commit in one pass costs ~20 MB of JSON and ~hundreds of ms of git2 work before the user sees anything.

We mirror Zed's two-phase approach (`crates/git/src/repository.rs:initial_graph_data` + `show`):

1. **Phase 1 — graph metadata stream.** Backend `list_commits_stream(branch, request_id)` walks the DAG, emitting chunks of 1000 with `{oid, parent_oids, refs}` only via `commit-history:chunk` Tauri events. Cancellable via `request_id` + an `AtomicBool`; cached by `(branch, head_oid)` and invalidated only when HEAD or branch changes.
2. **Phase 2 — lazy detail enrichment.** Frontend tracks the virtualized viewport and fires `get_commit_details_batch(oids)` for visible rows ± 50 prefetch, debounced 50 ms. Results cached in a session-wide `Map<oid, CommitDetails>`.

## Consequences

- Each phase-1 row is ~80 B; 100k commits ≈ 8 MB on the wire, comfortably handled by TanStack Virtual.
- Author/subject/date fade in as the user scrolls. Acceptable because the row layout is deterministic from the oid alone (avatar slot, monospace SHA, fixed height) — only text content fades.
- We diverge from cub's existing all-at-once IPC pattern (`get_repo_status`, `get_branch_diff`). This is the first endpoint that streams over an event channel rather than awaiting a single response. The cancellation generation pattern is borrowed from `AppState.watcher_generation`.
- Reversing this would mean re-introducing per-row IPC latency or eating the full payload up front. Both are worse than the current shape, but neither is catastrophic; the choice is recorded so the next maintainer doesn't try to "simplify" it back to a single-shot RPC.
