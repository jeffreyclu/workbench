# Implementation plan: harden and scale Workbench's most-used paths

## Decision and evidence

This plan continues the activity-log pass and the already-shipped read-mark fix in
`src/client/features/conversation/view.tsx`. The former top mutation volume was a
polling bug, not user demand; do not use it as a product signal.

The reliable user-level signals are `activities` where `actor = 'jeffrey'` (1,572
events, 2026-08-18 through 2026-08-25):

| Path | Events | Share | Direction |
| --- | ---: | ---: | --- |
| Send a conversation message (`chat_started`) | 963 | 61% | Harden first |
| Edit a task | 187 | 12% | Protect against conflicts and loss |
| Select a model | 162 | 10% | Preserve the selection through dispatch |
| Complete a task | 116 | 7% | Make the terminal transition reliable |
| Classify a task | 67 | 4% | Maintain; no expansion yet |

The most-used end-to-end path is therefore: **open a task or conversation → send
a message → observe the streamed result → execute/complete linked work**. It
crosses the conversation UI, shared-message routes, dispatch scheduler, agent-run
state, and realtime cache invalidation.

`POST /mcp` is also high-volume (1,375 calls) but 24% returned HTTP 400. The
current audit detail records only route and status, so this plan instruments that
path before changing its behavior.

## Goals and non-goals

- Make a sent message appear immediately, submit at most once, and survive a
  transient request failure without losing the draft or attachments.
- Stop browser polling from owning dispatch side effects; message reads must stay
  reads and scale with viewers rather than trigger repeated scheduling work.
- Keep server state authoritative and use TanStack Query for optimistic updates,
  targeted invalidation, and realtime reconciliation.
- Make task edits, model selection, and completion safe under stale tabs and
  concurrent agent activity.
- Measure MCP failures with method and sanitized error code before attempting a
  reliability fix.
- Do not deprecate low-frequency features from one week of data. Instrument and
  review them on a longer window first.

## Phase 0 — add decision-grade instrumentation

1. Extend `src/server/audit-log.ts` and the audit middleware to record a stable
   `operation` and `outcome` for each mutating REST request, plus an optional
   bounded/sanitized `reasonCode`. Keep message bodies, prompts, attachments,
   tokens, and user-entered text out of audit details.
2. In `src/server/workbench-mcp.ts`, wrap the Streamable HTTP handler so each MCP
   audit record includes the JSON-RPC method, protocol outcome, `ToolFailure`
   code (when present), and request duration. Preserve the existing structured
   `runTool` logs; the audit row is an aggregate-safe counterpart, not a second
   logging format.
3. Add explicit activity events for message submission accepted/rejected,
   dispatch started, first streamed response, terminal response, task edit
   conflict, and completion conflict. Attribute human, agent, and system actors
   separately so aggregate API traffic is never used as a proxy for Jeffrey's
   behavior.
4. Provide a repository/service-level activity rollup: unique actors, attempts,
   successes, rejects, p50/p95 time-to-first-response, p50/p95 terminal time,
   and reason-code counts by operation. The UI can consume this later; the first
   implementation only needs a tested query/service surface.

**Tests:** unit-test sanitization and operation mapping; route/MCP tests assert
that success, validation failure, conflict, and internal failure emit the expected
bounded fields. Add a migration only if a new persisted column/table is required;
make it forward-only and add an upgrade-path schema test.

## Phase 1 — harden sending and streaming (primary path)

1. Extract the message-send orchestration from
   `src/client/features/conversation/view.tsx` into a focused hook under
   `src/client/features/conversation/hooks/`. The view remains presentation and
   receives stable send state/actions.
2. Give each submission a client-generated idempotency key. Extend
   `createSharedMessageSchema`, `POST /api/shared/messages`, and repository write
   logic so a retry with the same conversation/key returns the original accepted
   message rather than creating a duplicate run. Persist the key in a new
   forward-only migration with a unique conversation/key constraint.
3. On submit, insert a clearly marked optimistic Jeffrey message into the
   `['shared-messages', conversationId]` cache, disable duplicate submit while
   that key is pending, and preserve the draft/files until the server accepts it.
   Replace or reconcile the optimistic row from the response, then invalidate
   only the affected message/conversation/work-item/insights queries.
4. On a network failure, keep the draft and attachments intact, show a local
   retry affordance with an accessible error message, and retry with the same
   idempotency key. Do not auto-replay an ambiguous failed request.
5. Replace the GET-handler scheduling side effect in
   `src/server/routes/conversation-router.ts` with an explicit, lease-safe
   dispatch trigger: enqueue on successful message creation; reclaim expired
   work from the existing scheduler only. `GET /api/shared/messages` should
   only read. Continue conditional polling while a message is queued/running,
   but use the existing `/api/realtime` invalidation transport to reconcile the
   active thread as soon as a message changes.
6. Preserve virtualized thread scroll behavior: optimistic rows need stable item
   keys, focused composer behavior must not jump, and new-response auto-scroll
   stays separate from read marking. Test mobile narrow-width composer, keyboard
   send, and attachment error state.

**Tests:** hook/component tests cover one request per rapid double submit,
optimistic success/reconciliation, rejected request, ambiguous failure + manual
retry, attachment retention, targeted cache invalidation, keyboard submit, and
screen-reader status. Server tests cover same-key replay, different-key distinct
messages, unique constraint behavior, and the fact that message GETs never
dispatch work. Add browser coverage for a streaming reply and repeat the route
switch sequence three times.

## Phase 2 — harden task edits, model choice, and completion

1. Centralize task-detail mutations in a task mutation hook layer rather than
   keeping individual callback policy in `features/task/view.tsx`. Keep existing
   TanStack Query keys and invalidation conventions.
2. Require the existing version/concurrency token for locally-owned edits and
   completion. On conflict, retain the draft, fetch the current item, present a
   field-level resolution state, and never overwrite agent/provider-owned data.
3. Persist model/execution-profile choice with the submitted message or run
   request and render the accepted choice beside the queued/running work. The UI
   must never show a selected model that the server declined or replaced.
4. Make completion idempotent. A repeated click/retry returns the already-terminal
   item; an incompatible active-run transition returns a specific conflict that
   explains the next safe action. Reconcile task, queue, conversation, and
   insights caches from the same mutation result.

**Tests:** acceptance coverage maps to each outcome: edit success/conflict,
model selection accepted/rejected, one terminal completion after repeated
requests, active-run conflict, cache reconciliation, keyboard controls, and a
phone-width task detail.

## Phase 3 — capacity and operational guardrails

1. Set explicit backpressure at the dispatch boundary: bounded queued turns per
   conversation, explicit queue position/status, and no duplicate active turn
   for the same idempotency key. Return typed 409/429-style results that the UI
   renders clearly; do not silently drop work.
2. Track queue wait, first-response, terminal duration, retries, duplicate-key
   replays, and dispatch reclaims. Alert/log when p95s regress or a reason code
   dominates; this catches a read-mark-style loop before it becomes the largest
   traffic source.
3. Load-test the service layer with concurrent sends to the same and different
   conversations. Verify leases prevent double dispatch and that reads remain
   constant-work under repeated polling/realtime reconnects.

## Deprecation policy for lesser-used paths

Do not remove a feature yet. Collect at least 30 days of actor-separated
instrumentation, then classify a candidate as:

- **Keep:** distinct successful use or a workflow-required safety/recovery action.
- **Consolidate:** overlapping entry points to the same action; retain a single
  discoverable path with compatibility redirects.
- **Deprecate:** no successful human use in 30 days, no system/workflow dependency,
  and a supported replacement. First hide it behind a reversible feature flag,
  observe for another release window, then remove UI and server route together.

Task/reference/conversation linking, archive/restore, and one-off discovery or
provider routes have too little history to meet this bar. Keep them unchanged for
now.

## Delivery order and verification gates

1. Phase 0 instrumentation and rollup, then review seven days of reason-code
   data before touching MCP reliability.
2. Phase 1 message idempotency + GET/dispatch separation. This is the highest
   return and the only phase that adds persistence; validate its migration on a
   copy of the current database, run its upgrade test, then start the candidate
   API health check before promotion.
3. Phase 2 task mutation hardening.
4. Phase 3 limits and load tests once measured queue behavior establishes sane
   thresholds.

For every material phase run `npm run typecheck`, `npm test`, and `npm run build`.
Browser verification is required for the message and mobile flows because jsdom
does not expose streaming, virtualized layout, or route-history failures.
