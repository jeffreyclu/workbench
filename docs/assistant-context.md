# Assistant Context Contract

Workbench tasks, conversations, and activity are the canonical shared context.

The shared room is the common conversation for Jeffrey, Codex, and Claude. Every task execution prompt includes:
- Recent completed room messages (last 6, capped to ~1.5 KB each)

## Rules

- Read the full work item before proposing or executing a strategy.
- Record durable decisions, progress, blockers, and handoffs as activity.
- Pass `actor` to `update_work_item` and `set_work_item_lifecycle` so the field changes and lifecycle moves you make are attributed in the task activity log. Workbench writes those entries automatically; do not duplicate them with `add_activity`.
- Keep strategy actionable: outcome, approach, assignments, risks, and verification.
- Do not modify provider-owned fields through local assistant tools.
- Do not mark an item done without recording verification evidence.
- Do not expose provider credentials or raw authentication material.
- `frontend-reviewer` is the only authoritative code-review persona and the only entry point for review executions. Its first pass is read-only: establish Linear/PR intent, inspect the diff and necessary surrounding code, assess correctness plus readability, maintainability, performance, scalability, security, and reliability, and label every finding blocking or non-blocking. Testing and runtime validation are separate executables.
- `frontend-engineer` is the principal frontend implementation persona for execute runs. It follows repository rules first, plans before coding, favors existing patterns and simple readable code, separates presentation/business logic/state/data access, treats the backend as the default source of truth, and maps every provided acceptance criterion to tests.
- `backend-engineer` is the principal backend implementation persona for server, API, persistence, integration, and background-processing execute runs. It follows repository rules and existing patterns first; plans across correctness, reliability, security, readability, maintainability, performance, and scalability; keeps architectural boundaries explicit; and treats failure modes, data ownership, compatibility, observability, and safe rollout as implementation concerns.

## Shared MCP tool surface

`/mcp` is the shared, stateless Streamable HTTP interface. It calls the same repository
layer as REST and never reads SQLite directly.

Codex and Claude have complete Workbench admin control here. Privileged Workbench-owned
operations are callable through MCP, including the irreversible ones.

- Tasks and stacks: `list_stacks`, `list_work_items`, `get_work_item`,
  `create_work_item`, `update_work_item`, `set_work_item_lifecycle`, `reorder_stack`,
  `add_activity`, `delete_work_item`, `unblock_work_item`, `manage_work_item_link`,
  `manage_work_item_reference`
- Discoveries: `list_discoveries`, `resolve_discovery`, `run_discovery_scan`
- Conversations: `list_conversations`, `get_conversation`, `create_conversation`,
  `add_conversation_message`, `dispatch_conversation_turn`, `cancel_conversation_message`,
  `manage_conversation`
- Plans and execution: `list_execution_plans`, `propose_execution_plan`,
  `resolve_execution_plan`, `list_results`, `execute_work_item`, `create_agent_run`,
  `cancel_agent_run`, `retry_agent_run`
- Artifacts: `publish_artifact`, `list_artifacts`, `revoke_artifact`
- Sources and providers: `list_source_connections`, `authorize_source_connection`,
  `set_figma_discovery_scope`, `disconnect_source_connection`, `get_linear_provider`,
  `sync_linear_provider`, `configure_linear_provider`, `queue_linear_work_item`
- Control plane and audit: `promote_runtime`, `list_audit_log`

Workbench writes its own routing decisions into the same activity log: the execution type
and why it was chosen, the agent and why, the model and effort tier, and any capacity
fallback. Jeffrey's own field edits and lifecycle moves — archive, complete, restore — are
logged there too, with the cause named when Workbench applied the move as a cascade. One
timeline explains a task.

Every completed state-changing REST request is also recorded centrally in the append-only
audit log and is searchable through activity memory. This generic request record complements,
rather than replaces, the task-specific activity entries above.

### What is still not here, and why

Nothing on this surface is withheld as a privilege. What is missing is missing because it
is not a Workbench operation: provider credentials, direct SQLite access, and general
machine administration. Assistant-authored mutations accept only `codex` or `claude`
actors — that is attribution, so the shared log never misreports who acted, not permission.

Two kinds of refusal remain, and both protect valid state rather than restricting agents:

- **Integrity refusals** are absolute — a dependency edge that would create a cycle, a
  stack order missing an item, a plan that is no longer pending, a second concurrent run
  against one workspace, an execution result being rewritten after the fact.
- **Workflow gates** are advisory and overridable. A task Jeffrey has claimed by assigning
  himself, a task with open prerequisites, and a task that already has a completed run all
  stop by default; pass `force: true` to proceed deliberately.

`promote_runtime` builds, verifies, and switches the live release immediately. The gateway
routes new requests to the candidate, then drains the previous backend until its in-flight
agent runs and background jobs have persisted their terminal state. Calls from preview are
stored durably and claimed by the live promotion worker; they are not permission-refused.
