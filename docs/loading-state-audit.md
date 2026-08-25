# Loading-state audit

Status: implemented 2026-08-24. All audited data-bearing surfaces now use their matching skeleton shell.

## Decision

Every loading placeholder must preserve the visible structure of the component it replaces. Audit all
initial and scoped loading states before implementing fixes. Prioritize the conversation window.

## Existing loading states

| Surface | Current state | Comparison with loaded structure | Finding |
| --- | --- | --- | --- |
| Insights | `InsightsSkeleton` and `UsageDialSkeleton` | Uses the same sections, stat grid, and usage-card grid as the page. | Matches; inspect visual dimensions during implementation only. |
| Sources dialog | `SourceConnectionCardSkeleton` | Preserves the connection-card summary, action, and metadata rows. | Matches. |
| Global search | `GlobalSearchResultSkeleton` | Preserves source, title, and two-line snippet result rows. | Matches. |
| Task rail | `TaskQueueSkeleton` | Uses the queue card shell, group header, project marker slot, copy, and metadata chips. | Matched. |
| Task detail | `TaskDetailSkeleton` | Uses the detail panel shell, title/metadata block, and section rhythm. | Matched. |
| Discovery inbox | `DiscoveryCardSkeleton` | Uses discovery articles with source/time, title, description, and action row. | Matched. |
| Artifact library | `ArtifactCardSkeleton` | Uses artifact card headers, metadata, link, and action rows. | Matched. |
| Artifact history panel | `ArtifactDetailSkeleton` | Uses the artifact detail divider and version/history/feedback sections. | Matched. |
| Conversation rail | `ListRowSkeleton` | Loaded content is grouped, virtualized conversation cards with origin, state, project marker, and metadata. | Replace with conversation-rail-card skeletons and group headers. |
| Conversation detail header | Spinner plus `Loading conversation…` | Loaded content is the console header, optional task controls, thread-filter bar, thread, and composer. | Replace; this is the reported broken conversation-window state. |
| Conversation message thread | `ListRowSkeleton` | Loaded content is author/time headers and variable-height message bodies, attachments, actions, and status. | Replace with message-card skeletons with varied body heights. |

## Components with an async dependency but no matching skeleton

| Component | Missing state | Required treatment |
| --- | --- | --- |
| Task-link candidate menus | `CandidateRowSkeleton` preserves icon, title, and project metadata. |
| Artifact-link candidate menu | `CandidateRowSkeleton` preserves icon, title, and version metadata. |
| Conversation search results | `ConversationSearchResultSkeleton` matches title, context, and result metadata. |
| Conversation/task rail pagination | Matching card skeletons append in place. |
| Navigation counts | Still use a fixed-width count placeholder; isolated inline polish, not a data-bearing component. |
| Figma connection scope | A textarea-shaped skeleton now holds the field space until scope data arrives. |

## Not in scope for skeleton replacement

Button mutation spinners (for example, saving, scanning, reconnecting, approving, and extracting)
correctly communicate an in-place action without replacing a data-bearing component. Keep them unless
their own button footprint shifts.

## Implementation order

1. Conversation window: header, thread, and composer shell; then conversation rail and search.
2. Task rail and task detail.
3. Discovery and artifact library/detail cards.
4. Candidate menus, pagination, and navigation-count polish.

## Acceptance checks

- Each skeleton uses the loaded component's outer class/layout and reserves its principal controls,
  metadata, and content blocks.
- Initial-load and scoped-search states have no bare `Loading…` text or spinner-only replacement for
  data-bearing UI.
- The conversation detail load shows the console header, thread-shaped message placeholders, and
  composer footprint from first paint.
- Narrow viewport layout preserves the same shell and does not introduce horizontal scrolling.
