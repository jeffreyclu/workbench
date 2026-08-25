# Loading-state audit

Status: audit only. No loading UI was changed.

## Decision

Every loading placeholder must preserve the visible structure of the component it replaces. Audit all
initial and scoped loading states before implementing fixes. Prioritize the conversation window.

## Existing loading states

| Surface | Current state | Comparison with loaded structure | Finding |
| --- | --- | --- | --- |
| Insights | `InsightsSkeleton` and `UsageDialSkeleton` | Uses the same sections, stat grid, and usage-card grid as the page. | Matches; inspect visual dimensions during implementation only. |
| Sources dialog | `SourceConnectionCardSkeleton` | Preserves the connection-card summary, action, and metadata rows. | Matches. |
| Global search | `GlobalSearchResultSkeleton` | Preserves source, title, and two-line snippet result rows. | Matches. |
| Task rail | `ListRowSkeleton` | Loaded content is grouped, virtualized `TaskQueueItem` cards with project/state metadata. | Replace with task-queue-card skeletons, including group headers. |
| Task detail | `ListRowSkeleton` | Loaded content is a detail workspace with title, metadata/actions, description, relationships, activity, and runs. | Replace with a task-detail skeleton that preserves its header and section layout. |
| Discovery inbox | `ListRowSkeleton` | Loaded content is `DiscoveryCard` articles: source/time, title, description, and actions. | Replace with discovery-card skeletons. |
| Artifact library | `ListRowSkeleton` | Loaded content is `ArtifactCard`: header, version/status tags, metadata, linked items, actions. | Replace with artifact-card skeletons. |
| Artifact history panel | `ListRowSkeleton` | Loaded content is source status, version list, event list, and comment thread. | Replace with an artifact-detail skeleton. |
| Conversation rail | `ListRowSkeleton` | Loaded content is grouped, virtualized conversation cards with origin, state, project marker, and metadata. | Replace with conversation-rail-card skeletons and group headers. |
| Conversation detail header | Spinner plus `Loading conversation…` | Loaded content is the console header, optional task controls, thread-filter bar, thread, and composer. | Replace; this is the reported broken conversation-window state. |
| Conversation message thread | `ListRowSkeleton` | Loaded content is author/time headers and variable-height message bodies, attachments, actions, and status. | Replace with message-card skeletons with varied body heights. |

## Components with an async dependency but no matching skeleton

| Component | Missing state | Required treatment |
| --- | --- | --- |
| Task-link candidate menus | `Loading tasks…` text while searching dependencies or linked tasks | Candidate-row skeletons that preserve icon, title, and project metadata. |
| Artifact-link candidate menu | `Loading artifacts…` text while searching | Artifact candidate-row skeletons that preserve icon, title, and version metadata. |
| Conversation search results | Spinner plus `Searching…` | Conversation search-result skeletons matching title, context, and result metadata. |
| Conversation/task rail pagination | Spinner plus `Loading more…` | Append matching card skeletons, not a page-state row. |
| Navigation counts | Literal `…` while count queries resolve | Reserve the count-pill width with inline skeletons. |
| Figma connection scope | The editable scope form renders before its query resolves, with an empty textarea | Add a scoped form skeleton or disable-and-skeletonize the field until its value is ready; avoid presenting an empty value as authoritative. |

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
