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

Each morning, Workbench scans configured sources: Slack, GitHub, Linear, Confluence, and Gmail. The scan considers new source activity together with the existing stack.

The result is a proposed order with a reason for every meaningful movement. Applying a proposal stores the complete previous ordering. Jeffrey can:

- Accept it, making the proposed order canonical.
- Reject it, restoring the exact pre-proposal order.
- Manually reorder it, superseding the proposal.

Agents should preserve yesterday's relative order by default. Recency alone is not sufficient reason to promote an item.

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
