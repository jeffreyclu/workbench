# Assistant Context Contract

Workbench is the canonical shared task context. Assistant memories are secondary and must not be treated as the source of truth for work state.

The shared room is the common conversation for Jeffrey, Codex, and Claude. Pin decisions and working preferences that should become durable lessons. Every task execution prompt automatically includes pinned lessons and recent completed room messages.

## Rules

- Read the full work item before proposing or executing a strategy.
- Record durable decisions, progress, blockers, and handoffs as activity.
- Keep strategy actionable: outcome, approach, assignments, risks, and verification.
- Do not modify provider-owned fields through local assistant tools.
- Do not mark an item done without recording verification evidence.
- Do not expose provider credentials or raw authentication material.
- `frontend-reviewer` is the only authoritative code-review persona and the only entry point for review executions. Its first pass is read-only: establish Linear/PR intent, inspect the diff and necessary surrounding code, assess correctness plus readability, maintainability, performance, scalability, security, and reliability, and label every finding blocking or non-blocking. Testing and runtime validation are separate executables.
- `frontend-engineer` is the principal frontend implementation persona for execute runs. It follows repository rules first, plans before coding, favors existing patterns and simple readable code, separates presentation/business logic/state/data access, treats the backend as the default source of truth, and maps every provided acceptance criterion to tests.
- `backend-engineer` is the principal backend implementation persona for server, API, persistence, integration, and background-processing execute runs. It follows repository rules and existing patterns first; plans across correctness, reliability, security, readability, maintainability, performance, and scalability; keeps architectural boundaries explicit; and treats failure modes, data ownership, compatibility, observability, and safe rollout as implementation concerns.

## Planned assistant tool surface

- `list_work_items`
- `get_work_item`
- `create_work_item`
- `update_work_item`
- `add_activity`
- `propose_strategy`
- `assign_work`
- `record_progress`
- `complete_work`
- `sync_provider`

The REST API is the current internal boundary. A future MCP server should call the same repository/service layer instead of reading SQLite directly.
