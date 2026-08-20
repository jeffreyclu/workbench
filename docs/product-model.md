# Workbench Product Model

## Operating principle

Workbench is Jeffrey's ordered attention stack. Jeffrey owns the stack. Agents gather context, propose reversible ordering changes, and execute the top-level tasks.

## Shared room

The shared room is the coordination layer for Jeffrey, Codex, and Claude. A message can ask both agents concurrently, target one agent, or simply record a thought. Messages persist locally in SQLite. Pinning a message promotes it to a durable lesson.

Every task execution receives the durable lessons plus the 30 most recent completed room messages. Running and failed placeholders are excluded. This gives every dispatched agent the same working context without allowing the prompt to grow without bound.

## Attention stack

- Position is priority; there is no independent priority score.
- The first active item requires the most attention.
- Existing relative order persists across days unless new evidence justifies promotion.
- Manual reordering always wins over prior agent proposals.

## Daily proposal

Each morning, Workbench scans configured sources: Slack, GitHub, Linear, Confluence, and Gmail. It then ranks the stack with a fixed set of named signals and gives every task a score:

- **Status** — work already in progress outranks work that is merely ready.
- **Agent outcome** — a run that failed or left follow-ups pulls its task up.
- **Aging** — days without activity, counted after the first day and capped so stale work never beats urgent work.
- **Deadline** — overdue, due within a day, due within three days.
- **Blockers** — waiting on open subtasks, or a blocker note nothing has resolved since.
- **Source change** — the task's source moved since the last plan.
- **Workload** — an agent is already on it, or too much is already in progress.
- **Feedback** — signals Jeffrey keeps accepting count for slightly more; ones he rejects count for less. The adjustment is clamped so no single signal can take over.

Two rules keep the stack calm and auditable:

1. **Yesterday's order is the default.** Ranking starts from the current order and only swaps neighbours whose score gap clears a stability margin. Near-ties never move. Recency alone is not a reason to promote.
2. **Every movement is explained and reversible.** A proposal carries a per-task record of its score, its signals, and where it moved. Applying a proposal stores the complete previous ordering.

Jeffrey can:

- Accept it, making the proposed order canonical.
- Reject it, restoring the exact pre-proposal order.
- Manually reorder it, superseding the proposal.
- Undo the last ordering change, whoever caused it — a proposal, a manual drag, or an agent promoting its own work. Undo walks back one change at a time and skips snapshots that no longer describe the current stack.

The planning agent argues with this ranking rather than replacing it: it sees every score and signal, and must name the source signal behind any departure. If it fails or returns malformed data, the deterministic order stands.

## Task creation

A task may be manual or backed by one or more source references. Pasting a supported URL resolves its source entity and generates a title and editable description.

- Existing source descriptions are preferred, including Linear issue descriptions.
- Missing descriptions are synthesized from available source context.
- Generated content remains local and editable.
- Source-owned content and local edits retain separate provenance.

## Execution

The task UI exposes one primary action: **Execute**.

The orchestrator classifies the work and selects the appropriate persona and runtime:

- Research → research agent
- Technical document → technical-spec writer
- Frontend coding/building → principal `frontend-engineer` persona
- Backend/API/data/integration coding → principal `backend-engineer` persona
- Code review → authoritative `frontend-reviewer` persona (read-only first pass; testing is a separate executable)
- Other work → a purpose-fit analysis or execution agent

Self-contained work runs directly. Complex work follows an approval gate:

1. Research relevant context.
2. Produce an implementation/strategy plan.
3. Present the plan to Jeffrey.
4. On approval, decompose it into independently executable, self-contained tasks.
5. Insert the new tasks into the attention stack in proposed order.

Execution history, outputs, evidence, and handoffs belong to the task—not to either assistant's private memory.

## Source adapters

The domain model is source-neutral. Each adapter provides authentication, URL recognition, entity resolution, incremental scanning, and normalized context. Initial adapters are Linear, Slack, GitHub, Confluence, and Gmail.

The local connection layer supports GitHub personal access tokens, Slack user tokens with `search:read`, Confluence email/API-token basic authentication, and Gmail OAuth access tokens. Secrets are stored only in the local SQLite database and are omitted from every read response. Gmail access tokens expire and must currently be replaced manually; refresh-token OAuth is a future hardening step.
