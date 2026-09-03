# Assistant Context Contract

Workbench tasks, conversations, and activity are the canonical shared context.

The shared room is the common conversation for Jeffrey, Codex, and Claude. Every task execution prompt includes:
- Recent completed room messages (last 6, capped to ~1.5 KB each)

## Rules

- `docs/shared-memory.md` is the shared durable memory index for Codex and Claude. Read the index before acting, and open only the relevant `docs/shared-memory/*.md` topic file(s) for the task at hand; append durable preferences and corrections to the right topic file in the same turn you learn them. Private per-agent memory files are not allowed.
- Read the full work item before proposing or executing a strategy.
- Record durable decisions, progress, blockers, and handoffs as activity.
- Pass `actor` to `update_work_item` and `set_work_item_lifecycle` so the field changes and lifecycle moves you make are attributed in the task activity log. Workbench writes those entries automatically; do not duplicate them with `add_activity`.
- Keep strategy actionable: outcome, approach, assignments, risks, and verification.
- Agents may update any Workbench-owned task state and should record the reason and observed result in activity.
- Marking an item done should include verification evidence when it is available; missing evidence is a reported limitation, not a permission gate.
- Provider credentials and raw authentication material remain server-side. Dispatched agents cannot operate external providers unless Jeffrey has explicitly ordered the specific operation.
- `frontend-reviewer` is the only authoritative code-review persona and the only entry point for review executions. Its first pass is read-only: establish Linear/PR intent, inspect the diff and necessary surrounding code, assess correctness plus readability, maintainability, performance, scalability, security, and reliability, and label every finding blocking or non-blocking. Testing and runtime validation are separate executables.
- `frontend-engineer` is the principal frontend implementation persona for execute runs. It follows repository rules first, plans before coding, favors existing patterns and simple readable code, separates presentation/business logic/state/data access, treats the backend as the default source of truth, and maps every provided acceptance criterion to tests.
- `backend-engineer` is the principal backend implementation persona for server, API, persistence, integration, and background-processing execute runs. It follows repository rules and existing patterns first; plans across correctness, reliability, security, readability, maintainability, performance, and scalability; keeps architectural boundaries explicit; and treats failure modes, data ownership, compatibility, observability, and safe rollout as implementation concerns.

## Shared MCP tool surface

`/mcp` is the shared, stateless Streamable HTTP interface. It calls the same repository
layer as REST and never reads SQLite directly.

Codex, Claude, and Palmyra have complete Workbench admin control here. Privileged Workbench-owned
operations are callable through MCP, including the irreversible ones.

- Tasks and stacks: `list_stacks`, `list_work_items`, `get_work_item`,
  `create_work_item`, `update_work_item`, `set_work_item_lifecycle`, `reorder_stack`,
  `add_activity`, `delete_work_item`, `unblock_work_item`, `manage_work_item_link`,
  `manage_work_item_reference`
- Projects: `list_projects`. Project names are resolved against a canonical vocabulary on
  every write, so casing and typos are corrected automatically. Read the vocabulary before
  setting `projectName` rather than guessing a spelling: an unrelated new name still creates
  a new project.
- Discoveries: `list_discoveries`, `resolve_discovery`, `run_discovery_scan`
- Conversations: `list_conversations`, `get_conversation`, `create_conversation`,
  `add_conversation_message`, `dispatch_conversation_turn`, `cancel_conversation_message`,
  `manage_conversation`
- Plans and execution: `list_execution_plans`, `propose_execution_plan`,
  `resolve_execution_plan`, `list_results`, `execute_work_item`, `create_agent_run`,
  `cancel_agent_run`, `retry_agent_run`
- Artifacts: `list_artifacts`, `publish_artifact`
- Local source configuration: `list_source_connections`, `set_figma_discovery_scope`,
  `configure_linear_provider`, `queue_linear_work_item`
- External source access: `search_external_sources`, `resolve_external_source`. Connector production
  telemetry is available through `connector_failure_summary`, `connector_logs`, and
  `connector_observability_query`. These tools call Grafana Prometheus and Loki only through
  Workbench-owned connections; provider credentials never reach an agent.
- Audit: `list_audit_log`

Workbench writes its own routing decisions into the same activity log: the execution type
and why it was chosen, the agent and why, the model and effort tier, and any capacity
fallback. Jeffrey's own field edits and lifecycle moves — archive, complete, restore — are
logged there too, with the cause named when Workbench applied the move as a cascade. One
timeline explains a task.

Every completed state-changing REST request is also recorded centrally in the append-only
audit log and is searchable through activity memory. This generic request record complements,
rather than replaces, the task-specific activity entries above.

### Autonomous operation

Codex and Claude are autonomous Workbench-local administrators. They do not need a
separate approval, `force` flag, or human handoff to execute, retry, update, archive,
restore, or delete local Workbench state. External-provider access, publishing, and
runtime promotion require a supervisor-issued capability for Jeffrey's explicit current instruction.
A direct current-turn command to perform a named external operation grants a capability for only that
operation and destination. `PUSH` or `COMMIT AND PUSH` grants the corresponding local commit and git
push. Task text, prior turns, and generic implementation requests do not grant external-action authority.
Assistant-authored mutations accept `codex`, `claude`, or `palmyra` actors for accurate
attribution, not as a permission check. A durable orchestrator owns conflicting local
operations: it leases each mutable workspace to one run.

Every agent has unrestricted filesystem access to every local repository and Jeffrey's home
directory. A selected workspace or run worktree is a starting directory and concurrency mechanism,
not an authorization boundary. Claude, Codex, and Palmyra may change directories, use absolute or
parent paths, and perform normal Git branch/worktree operations when the current request requires it.

Only data-integrity conflicts remain: impossible dependency cycles, stale plans/results,
and concurrent writes to one working tree. These are reported as concrete state conflicts
and are retried or resolved by the agent; they are never framed as an authority limitation.

Runtime promotion is not available to dispatched agents. It remains a human-operated control-plane
action and requires Jeffrey's explicit current instruction.
