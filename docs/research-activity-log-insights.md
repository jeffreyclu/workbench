# Research: extracting insights from activity-log data

**Task type:** research only — no code changed, no product recommendation implied. See scope note
at the end.

## 1. What Workbench's activity data actually is

Two tables, read directly from `src/server/database.ts` and `src/server/activity-log.ts`:

- `activities` (`work_item_id`, `actor`, `kind`, `body`, `created_at`, indexed on
  `(work_item_id, created_at DESC)`) — one row per task lifecycle event: status/priority/owner/label
  changes, lifecycle moves (archive/complete/restore), execution routing decisions, model selection,
  agent fallbacks, link/reference add-remove, deletes. `actor` is `'jeffrey' | 'system'` (human vs.
  Workbench-initiated).
- `audit_log` (`category` ∈ `outbound_call | agent_file_read | agent_file_write | agent_tool_use |
  destructive_action | api_mutation`, `source`, `detail`, `work_item_id`, `created_at`, indexed on
  `created_at` and on `(category, created_at)`) — a flatter, security/ops-oriented event stream.

Structurally this is a **classic case/activity/timestamp event log**: `work_item_id` is a case
identifier, `kind`/`category` is the activity label, `created_at` is the timestamp, and `actor`/
`source` is the resource/agent that performed it. That three-field minimum (case ID, activity,
timestamp) is exactly the input format required by process-mining tooling, which matters because it
means Workbench's existing schema needs no redesign to support most of the techniques below —
only a read path.

## 2. Analytical approaches, mapped to this schema

### 2a. Process mining (best fit for the `activities` table)

Because `activities` already has case ID + activity + timestamp, standard process-mining techniques
apply directly ([process mining event-log requirements](https://www.processmining.org/event-data.html),
[Salesforce overview](https://www.salesforce.com/agentforce/process-mining/)):

- **Process discovery** — replay the `kind` sequence per `work_item_id` to infer the *actual* task
  lifecycle graph (e.g., how often `status: backlog → in_progress → done` is interrupted by
  `archive`/`restore`, how often execution routing changes mid-task). This surfaces the real
  lifecycle shape, not the one implied by the state machine in code.
- **Conformance checking** — compare discovered traces against an intended lifecycle model to flag
  deviations (tasks that ping-pong between statuses, tasks archived without completing repeatedly).
- **Cycle-time / bottleneck analysis** — time between consecutive `kind` events per case is a direct
  proxy for how long a task sits at each lifecycle stage, without adding any new instrumentation.

### 2b. Product/behavioral analytics (funnel, cohort, retention, engagement)

The standard product-analytics techniques — funnel analysis (drop-off between steps), cohort
analysis (grouping by shared starting attribute to compare outcomes), retention curves, and
engagement scoring — all require the same three primitives (what/when/who) plus a stable actor
identity to group by ([Mixpanel 2026 product-analytics guide](https://mixpanel.com/blog/what-is-product-management-analytics/),
[Contentsquare tools guide](https://contentsquare.com/guides/product-analytics/tools/)). Workbench's
`actor` field is coarse (`'jeffrey' | 'system'`/`'human'`), so these techniques are directly
applicable to **task-level cohorts** (e.g., tasks grouped by project, source, or creation week,
compared on completion rate and cycle time) but not to **per-person** behavioral analytics — there
is only one human actor in this dataset today.

### 2c. Anomaly detection on `audit_log`

Audit-trail anomaly detection distinguishes **point anomalies** (a single event far outside the norm
— e.g. one `destructive_action` at an unusual hour) from **contextual anomalies** (an event that is
only abnormal given its context — e.g. an unusually high rate of `agent_tool_use` for a given
`source` in a short window) ([behavioral-analytics anomaly taxonomy](https://medium.com/@RocketMeUpCybersecurity/using-behavioral-analytics-to-identify-anomalous-user-activity-6788db431f71),
[audit-trail anomaly mechanisms](https://www.myshyft.com/blog/anomaly-detection-mechanisms/)).
Baseline-and-deviation approaches (rolling mean/stddev of event rate per `category`/`source`) are
enough to start; full ML-based sequence models are a later-stage option only if simple thresholds
prove insufficient.

### 2d. Sequence/pattern mining

Because both tables are already ordered event sequences, simple **n-gram/Markov analysis** over
`kind` sequences per `work_item_id` can answer "what usually happens right before a task gets
archived without completing" or "which model-selection reasons precede an agent fallback" — cheaper
than full process discovery and a good first cut before investing in a process-mining library.

## 3. Implementation options, roughly ordered by effort

| Approach | Effort | What it needs beyond current schema |
|---|---|---|
| Cycle-time / time-in-status report (SQL only: `LAG(created_at) OVER (PARTITION BY work_item_id ORDER BY created_at)`) | Low | Nothing — pure query over `activities` |
| n-gram/Markov sequence analysis over `kind` | Low–Medium | Nothing — batch job or on-demand query |
| Task cohort comparison (by project/source/week) | Medium | Nothing — `activities` joined to `work_items` already carries project/source |
| Rolling-baseline anomaly flags on `audit_log` rate by `category`/`source` | Medium | Nothing — windowed aggregate query |
| Full process discovery / conformance checking (e.g. via a PM4Py-style library) | High | An export path to a standard event-log format (XES/CSV) and a discovery algorithm (e.g. Inductive Miner) |
| Per-person engagement/retention analytics | Blocked | A real multi-actor identity model — today's `actor` field only distinguishes human vs. system, not individual people |

## 4. Scope note (conflict flagged before proceeding)

`docs/shared-memory/workbench-operating-practices.md` records that Jeffrey has **permanently
rejected "audit-log/ops dashboards" framed as Workbench improvements** — that framing reads as
"backend shit" to him even when well-evidenced. This document is deliberately scoped as external,
informational research into *general* activity-log analytical techniques and how they map onto
Workbench's existing schema — it is **not** a recommendation to build an ops/audit dashboard, and no
UI or backend change is proposed here. Any follow-up that turns this into a concrete feature should
be framed as user-facing value (e.g., "how long do tasks actually sit in each state" surfaced to
Jeffrey), not as an audit/ops tool, per that standing preference.

## Sources

- [Process Mining — event log data requirements](https://www.processmining.org/event-data.html)
- [What Is Process Mining? — Salesforce](https://www.salesforce.com/agentforce/process-mining/)
- [Process Mining Explained — Latenode](https://latenode.com/blog/what-is-process-mining)
- [What is product analytics? — Mixpanel 2026 guide](https://mixpanel.com/blog/what-is-product-management-analytics/)
- [The 7 Best Product Analytics Tools — Contentsquare 2026](https://contentsquare.com/guides/product-analytics/tools/)
- [Using Behavioral Analytics to Identify Anomalous User Activity](https://medium.com/@RocketMeUpCybersecurity/using-behavioral-analytics-to-identify-anomalous-user-activity-6788db431f71)
- [Audit Trail Anomaly Detection mechanisms — myshyft](https://www.myshyft.com/blog/anomaly-detection-mechanisms/)
- [Event Sourcing Pattern — Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
