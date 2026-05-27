# Cub

Local Tauri desktop app for reviewing git changes — uncommitted work today, plus historical commits and branch deltas — with an MCP bridge that exposes review comments to AI agents.

## Language

**Working Changes**:
Uncommitted edits in the workdir. The default review surface. Lives in the `Changes` sidebar tab. Backed by `RepoStatus { staged, unstaged, untracked }`.
_Avoid_: "diff", "WIP", "uncommitted diff"

**History**:
Commits walking back from HEAD on the current branch (all ancestors, full DAG, date order). Lives in the `History` sidebar tab.
_Avoid_: "log", "commits view"

**Commit Detail**:
The right-pane view shown when a single commit is selected on the History tab. Composed of a header (avatar, author, date, email, SHA copy button), the commit message, and the file diffs.
_Avoid_: "commit view", "commit page"

**Branch Diff**:
HEAD vs the merge-base of the default branch (`origin/HEAD` → `main` → `master` → `trunk`). A transient mode launched from the empty `Changes` view. Mirrors what a PR would look like.
_Avoid_: "PR diff", "branch compare"

**Lazy enrichment**:
Two-phase commit-history load. Phase 1: stream `{oid, parent_oids, refs}` rows for the entire walk. Phase 2: batch-fetch `{subject, author, date, email, ...}` on demand for the visible window. Mirrors Zed's `initial_graph_data` + `show()` split.
_Avoid_: "lazy load" (too generic), "paginated history" (we don't paginate, we stream)

**Review**:
A batch of inline comments the user accumulates on Working Changes and submits via the MCP `get_review` tool for an external agent to consume. **Only applies to Working Changes** — history and branch-diff views are read-only.
_Avoid_: "annotations" (that's the UI substrate), "comments" alone (ambiguous with code comments)

## Relationships

- A **Repository** has one current **Branch** (or detached HEAD) whose tip is the **HEAD** commit.
- **Working Changes** are the diff between **HEAD** and the workdir/index.
- **History** is the ancestor chain of **HEAD**; each entry is a commit whose **Commit Detail** can be displayed.
- **Branch Diff** is **HEAD** vs the merge-base with the default branch.
- A **Review** is a list of comments anchored to lines inside **Working Changes**; submitting it ships them to the MCP sidecar.

## Flagged ambiguities

- "Changes" was used to mean both the sidebar tab and the diff content. Resolved: **Working Changes** is the diff content; the tab is named `Changes` in the UI but the underlying sidebar mode is `working`.
- "Commit" was overloaded with "commit-the-action" (creating one) and "commit-the-object" (a node in history). The action lives only on the `Changes` tab via the commit bar; everywhere else "commit" refers to the object.
