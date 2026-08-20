# ConnectorsTab behavior-preserving decomposition plan

Status: proposed  
Scope: frontend-only refactor; no visual or product behavior changes  
Primary component: `frontend/src/components/agents/manage-tabs/connectors-tab.tsx`

## Outcome

Decompose `ConnectorsTab` before the Manage Connectors design diff lands so the design work can target a presentational
table shell without also editing feature flags, queries, permissions, consent, modal state, or mutations. The refactor
must preserve the behavior of both `connector-gateway` states and must not change WDS primitives or their contracts.

The target dependency direction is:

```text
connectors-tab.tsx (composition root)
├── use-connectors-tab-data.ts (flag, queries, permissions, provider contract)
├── use-connectors-list-state.ts (search, sort, page projection)
├── use-connectors-modal-orchestration.ts (selection, consent, flows, mutations)
└── connectors-table-shell.tsx (presentational page/table states)
    ├── connector-table-row.tsx
    └── connector-row-status.tsx

Existing modal components remain leaf owners:
explore-connectors-modal.tsx
preview-connector-modal.tsx
connect-connector-modal.tsx
connect-api-key-modal.tsx
allow-connectors-modal.tsx
```

No new global state, context, dependency, API endpoint, generated client, or WDS primitive is proposed.

## Target modules and contracts

Every new module is co-located under `frontend/src/components/agents/manage-tabs/` because it has one consumer and is
private to this feature.

### `frontend/src/components/agents/manage-tabs/use-connectors-tab-data.ts`

Own the flag/data seam and expose one stable, provider-neutral contract to the rest of the tab.

Responsibilities:

- Read `connector-gateway` exactly once with `useFeatureFlag`.
- Read unified user profiles with `useListUnifiedUserProfiles`; flatten pages and expose initial-loading, page-draining,
  later-page-error, retry, and fetching state without changing the existing eager page-drain behavior.
- Invoke both `useAgentConnectors` and `useCgConnectors` unconditionally, preserving React hook ordering, and select the
  active result behind the flag. The coordinating flag-gating task may later add supported `enabled` inputs to prevent
  inactive network work; that change belongs in this module and the provider hooks, not in the table shell.
- Own `usePermissions` and expose `canOpenExploreMore` plus `isLoadingPermissions`.
- Own derived server-data projections that do not depend on list controls: signed logo URLs, tool totals, profile counts,
  and selected-provider `configData` / `defaultProfileIds`.
- Expose the selected provider operations without invoking UI workflows: `onConnectorEnabledChange`,
  `onConnectorToolToggle`, `isToolConnected`, `onSetDefault`, and `onProfileRevoked`.
- Expose gateway-only operations needed by the orchestrator: organization-profile connect, user-profile delete, and the
  boolean provider mode. Do not leak mutation objects when a narrow command is sufficient.

Contract requirement: consumers must not branch on the flag to select `useAgentConnectors` versus `useCgConnectors`.
The only permitted mode checks outside this hook are workflow differences that are real product behavior (organization
profile connect, API-key credential collection, and legacy post-auth enablement).

### `frontend/src/components/agents/manage-tabs/use-connectors-list-state.ts`

Own the complete client-side list projection. It accepts the loaded connector array plus the selected provider's
`configData` and returns render-ready rows and WDS pagination props.

Responsibilities:

- Own `usePaginatedSearch`, including the 25-row default, controlled search value, debounce, page size, and offset.
- Own `sortField` and `sortOrder`, including name/status toggling and the existing status precedence.
- Own search matching across connector name, display name, profile name, and description.
- Own sorted and paginated connector derivation.
- Own the page-reset scroll callback when offset or page size changes.
- Return a presentation-facing contract: `searchTerm`, `setSearchTerm`, `sortField`, `sortOrder`, `onSort`,
  `filteredCount`, `visibleConnectors`, and `pageControls`.

The hook must remain a pure client projection over all loaded pages. Moving search, sort, or pagination to the server is
out of scope because it would change observable partial-load behavior and API semantics.

### `frontend/src/components/agents/manage-tabs/use-connectors-modal-orchestration.ts`

Own modal state and all user-action workflows that cross modal or provider boundaries. It receives the data hook's
provider-neutral operations and connector collection; it does not fetch connector lists or render UI.

Responsibilities:

- Own the selected connector ID and resolve the selected connector from the current loaded collection.
- Own open/close state for Explore, Preview, API-key, OAuth, and Allow Connectors consent flows.
- Own the single-open-row-menu profile ID because it is transient interaction state coupled to action dispatch.
- Own pending consent intent as the discriminated pair `{ action: connect | enable, source: table | preview }`.
- Own connector click, Preview/Explore close coupling, consent accept/cancel, and selected-connector cleanup.
- Own `useConnectorAuth` and preserve legacy post-auth enabling while leaving connector-gateway post-auth unchanged.
- Own connection dispatch: deduplicate concurrent organization-profile connects by profile ID, route user API-key
  profiles to `ConnectApiKeyModal`, and route remaining profiles to OAuth.
- Own enable/disable, set-default, revoke, and destructive user-profile deletion sequencing. Preserve the invariant that
  gateway deletion occurs only after `onProfileRevoked` returns success.
- Return narrow event handlers and modal props to the composition root; do not return raw state setters.

Consent storage remains owned by `allow-connectors-modal.tsx` through `hasConnectorsConsent` and
`ALLOW_CONNECTORS_STORAGE_KEY`. The orchestrator decides when consent is required and what deferred action resumes;
the modal remains responsible for persisting acceptance.

### `frontend/src/components/agents/manage-tabs/connectors-table-shell.tsx`

Be the direct design-diff surface. This component receives render-ready state and callbacks only; it must not import
feature flags, permissions providers, TanStack Query hooks, connector mutations, consent storage, or auth hooks.

Responsibilities:

- Render the optional Connectors section heading and description.
- Render initial skeleton, empty library, search/action bar, partial-page loading notice, partial-page error/retry,
  no-search-results state, table headers/columns, rows, and sticky pagination.
- Render `ExploreMoreAction` from the supplied permission/loading values.
- Map `visibleConnectors` to `ConnectorTableRow` using supplied logo, status/config, counts, defaults, connecting state,
  menu state, and callbacks.
- Keep WDS composition, semantic table structure, accessible action names, keyboard behavior, loading/error text, and
  focus behavior unchanged during extraction.

This is the only module a later design change should need for search/action bar layout, table columns, pagination, and
loading/error presentation. A design requiring row-internal changes can additionally touch `connector-table-row.tsx`
or `connector-row-status.tsx`; it must not pull orchestration back into the shell.

### Existing-module ownership after extraction

- `frontend/src/components/agents/manage-tabs/connectors-tab.tsx`: composition root only. Wire the three hooks to the
  table shell and existing modal leaves. It owns no feature state or business branching.
- `frontend/src/components/agents/manage-tabs/connector-table-row.tsx`: one row's layout, menu presentation, row-level
  status-to-intent translation, and event propagation. It does not decide consent or invoke provider mutations.
- `frontend/src/components/agents/manage-tabs/connector-row-status.tsx`: pure status presentation for connected,
  disconnected, login-required, API-key-required, and connecting states.
- `frontend/src/components/agents/manage-tabs/explore-connectors-modal.tsx`: Explore dialog's internal search,
  categories, responsive layout, catalog query, and catalog pagination. Its state is separate from the main table list
  hook and should not be unified in this refactor.
- `frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx`: connector detail/tool presentation and its
  internal tool-query/auth polling behavior. Cross-modal open/close decisions come from the orchestrator.
- `frontend/src/components/agents/manage-tabs/connect-connector-modal.tsx`: OAuth dialog lifecycle and polling UI,
  supplied through `useConnectorAuth` props.
- `frontend/src/components/agents/manage-tabs/connect-api-key-modal.tsx`: API-key input, validation, submission state,
  and profile-creation mutation.
- `frontend/src/components/agents/manage-tabs/allow-connectors-modal.tsx`: consent copy and persistence only.

## Single-owner responsibility map

Each current `ConnectorsTab` responsibility has exactly one target owner:

| Current responsibility | Sole target owner |
|---|---|
| Feature-flag read and legacy/gateway selection | `use-connectors-tab-data.ts` |
| Unified profile query and eager page drain | `use-connectors-tab-data.ts` |
| Initial, draining, and later-page-error data states | `use-connectors-tab-data.ts` |
| Permission check for Explore | `use-connectors-tab-data.ts` |
| Logo/tool/profile-count data projections | `use-connectors-tab-data.ts` |
| Provider-neutral connector operation contract | `use-connectors-tab-data.ts` |
| Search input/debounce/filtering | `use-connectors-list-state.ts` |
| Name/status sorting | `use-connectors-list-state.ts` |
| Main-table page size, offset, and page controls | `use-connectors-list-state.ts` |
| Content scroll reset after page changes | `use-connectors-list-state.ts` |
| Selected connector and row-menu state | `use-connectors-modal-orchestration.ts` |
| Explore/Preview/API-key/OAuth/consent modal coordination | `use-connectors-modal-orchestration.ts` |
| Consent deferral and resumption | `use-connectors-modal-orchestration.ts` |
| Connect/enable/default/revoke/delete mutation orchestration | `use-connectors-modal-orchestration.ts` |
| Organization-profile in-flight deduplication | `use-connectors-modal-orchestration.ts` |
| Header, action bar, notices, empty states, table, and pagination rendering | `connectors-table-shell.tsx` |
| Row layout/menu and row-status intent mapping | `connector-table-row.tsx` |
| Status visual | `connector-row-status.tsx` |
| Explore catalog internals | `explore-connectors-modal.tsx` |
| Preview/tool internals | `preview-connector-modal.tsx` |
| OAuth dialog internals | `connect-connector-modal.tsx` |
| API-key form/mutation internals | `connect-api-key-modal.tsx` |
| Consent persistence | `allow-connectors-modal.tsx` |
| Dependency wiring only | `connectors-tab.tsx` |

## Coordination with the connector-gateway flag-gating task

Both tasks touch the data seam and must not land as independent competing abstractions.

1. The decomposition should establish `use-connectors-tab-data.ts` and preserve today's unconditional hook calls first.
   This is behavior-preserving and gives the flag task one integration point.
2. The flag task should then add supported `enabled` controls to inactive query/provider hooks, if its acceptance
   criteria require avoiding inactive requests. It must not conditionally call hooks.
3. The flag task owns changes inside shared hooks such as `useAgentConnectors`, `useCgConnectors`, or gateway query
   hooks. This decomposition owns only their composition and normalized return contract.
4. If the flag task lands first, the extraction must move its final gating logic intact into
   `use-connectors-tab-data.ts`; it must not restore unconditional network activity.
5. Merge conflict resolution must preserve one `useFeatureFlag('connector-gateway')` read and one normalized contract.

This ordering avoids a long-lived wrapper abstraction: the data hook is a page controller boundary, not a second query
layer, and it delegates all actual server state to existing TanStack Query owners.

## Independently mergeable extraction sequence

Each step must preserve rendered behavior and pass the focused suite before the next begins.

1. **Extract list state.** Add `use-connectors-list-state.ts`, move constants/status sorting/search/slice/pagination and
   scroll-reset behavior into it, and keep `ConnectorsTab` markup and callbacks unchanged. Add focused hook tests for
   name/status sort toggling, search fields, page reset, and page slicing.
2. **Extract the presentational shell.** Add `connectors-table-shell.tsx` and move only Header, skeleton/empty/search,
   notices, table, row mapping, and pagination markup. Keep existing callbacks and state in `ConnectorsTab`. Add shell
   tests for loading, empty, partial-load, partial-error/retry, no-results, permission loading/denial, sortable headers,
   and visible rows. At this point a design diff has a stable presentation target.
3. **Extract the flag/data seam.** Add `use-connectors-tab-data.ts`; move queries, eager draining, permissions, derived
   maps/counts, both provider hooks, and flag selection without changing request timing. Add contract tests for both
   flag values and the partial-page state machine. Rebase or serialize this step with the flag-gating task.
4. **Extract modal and action orchestration.** Add `use-connectors-modal-orchestration.ts`; move modal/menu/selection
   state, auth, consent, connection routing, in-flight organization connections, enable/default/revoke/delete flows,
   and modal props. Retain the existing modal component APIs. Add hook tests for each transition and failure guard.
5. **Reduce `ConnectorsTab` to composition.** Wire the hooks, shell, and five modal leaves. Move the existing integration
   tests to assert the composed public behavior rather than hook implementation details. No file renames or barrel are
   needed; existing imports of `ConnectorsTab` remain stable.

Do not combine steps 3 and 4: the provider-selection contract should be reviewable before mutation workflow state moves
behind it. Do not combine this refactor with the Figma design changes; the last green refactor commit is the comparison
baseline for visual work.

## Behavior-preservation test strategy

Keep `frontend/src/components/agents/manage-tabs/connectors-tab.test.tsx` as the composition-level regression suite and
add colocated tests for each extracted hook/shell only where they protect a distinct behavior. Do not duplicate the
same assertion at every layer.

Run the same contract matrix with `connector-gateway = false` and `connector-gateway = true`:

| Behavior | Flag off: legacy agent config | Flag on: connector gateway |
|---|---|---|
| Provider contract | `useAgentConnectors` result selected | `useCgConnectors` result selected |
| Authentication success | Enables the authenticated profile in agent config | Does not issue a redundant enable/connect |
| Standard user connect | Starts OAuth | Starts OAuth unless a gateway-specific branch applies |
| Organization credential | Existing legacy authorization path | Calls organization-profile connect once per profile while pending |
| User API key | Existing legacy authorization path | Opens API-key modal and creates the user profile |
| Enable with no consent | Defers, then resumes legacy enable | Defers, then resumes gateway enable |
| Revoke | Agent-config cleanup must succeed before profile delete | Gateway contract returns safe-to-delete, then user profile deletes |
| Set default/tool toggle | Legacy mutation contract | Gateway mutation contract |
| Search/sort/page | Same loaded rows, ordering, and page controls | Same loaded rows, ordering, and page controls |
| Query pagination | Same eager drain, incomplete-results notice, retry, and loaded-row retention | Same eager drain, incomplete-results notice, retry, and loaded-row retention |
| Modal transitions | Same Explore → Preview behavior, close behavior, consent accept/cancel, and focus restoration | Same |

Required focused coverage:

- Data hook: both flags, selected contract identity, permission states, empty/initial loading, drain continuation,
  stop-on-error, manual retry, and inactive-provider behavior defined by the coordinated flag task.
- List hook: all four searchable fields, stable name/status ordering, ascending/descending toggles, search reset to page
  one, page-size reset, and `onContentScrollReset` invocation.
- Orchestrator: table versus Preview consent source cleanup, connect versus enable resumption, concurrent organization
  profile deduplication, independent in-flight IDs, API-key routing, OAuth routing, legacy post-auth enable, gateway
  post-auth no-op, revoke failure preventing delete, and Explore/Preview close coupling.
- Shell: accessible search name, semantic headers/rows, keyboard-operable sort/action controls, visible initial/partial
  loading and error feedback, retry disabled while fetching, permission-gated Explore action, and pagination props.
- Existing modal tests remain with their current owners; this refactor should not rewrite their internal coverage.

Verification for each merge step:

```bash
cd frontend
pnpm vitest run src/components/agents/manage-tabs/connectors-tab.test.tsx
pnpm type-check
```

Before the complete refactor merges, run `pnpm lint:fix`, `pnpm format`, `pnpm type-check`, and the focused tests for
all new modules. Run `pnpm test:unit` if the branch is otherwise ready for the normal frontend pre-flight. A keyboard
pass must confirm search, sortable headers, row actions, pagination, consent, and dialog focus restoration in both flag
states; automated tests cannot fully prove focus behavior.

## Non-goals and rollout

- No Figma-driven visual, copy, spacing, column, responsive, loading, or error-state change.
- No WDS primitive edits, forks, deep overrides, or dependency updates; any design-system gap is escalated to
  `fe.wds` after the design diff is inspected.
- No server-side search/pagination redesign and no change to eager draining of unified-profile pages.
- No rewrite of the gateway adapter or its lossy synthetic legacy shape.
- No change to consent persistence, connector authorization protocols, query keys, analytics, permissions, or API
  payloads.
- No folder/barrel migration until reuse or module size justifies it.

The refactor needs no runtime flag of its own because each step is behavior-preserving and independently revertible.
The rollout guard is the existing `connector-gateway` matrix: do not remove the legacy path or its coverage while that
flag can be false. If production evidence finds a mismatch, revert the latest extraction step rather than patching
provider logic into the table shell.

## Risks and review focus

- **Hook ordering/network behavior:** never select provider hooks by conditionally calling them. Coordinate `enabled`
  semantics with the flag task.
- **Stale connector selection:** resolve selected ID against current query data on every render; a deleted/refetched
  profile must produce `null`, not a stale copied connector object.
- **Concurrent mutations:** retain the ref-backed organization-profile dedupe guard; state alone is not synchronous.
- **Legacy full-config writes:** keep mutation sequencing inside the existing provider hook so this refactor cannot
  reintroduce stale-snapshot clobbering.
- **Consent cleanup:** table-source cancellation currently clears selection while Preview-source cancellation keeps it;
  preserve and test that distinction.
- **Partial query results:** search/sort/page operate on loaded pages while draining or after a later-page failure; do
  not present the loaded count as the server total.
- **Accessibility:** moving markup must preserve semantic tables, accessible control names, focus order, dialog focus
  restoration, and programmatic loading/error feedback.

## Acceptance criteria mapping

| Required outcome | Plan location |
|---|---|
| Name every new module and target path | Target modules and contracts |
| Extract the flag/data seam | `use-connectors-tab-data.ts` |
| Extract search/sort/page state | `use-connectors-list-state.ts` |
| Extract modal orchestration | `use-connectors-modal-orchestration.ts` |
| Leave a design-ready presentational table shell | `connectors-table-shell.tsx` |
| Assign every listed responsibility exactly once | Single-owner responsibility map |
| Independently mergeable sequence | Independently mergeable extraction sequence |
| Preserve both `connector-gateway` states | Behavior-preservation test strategy |
| Coordinate the overlapping flag task | Coordination with the connector-gateway flag-gating task |
| Remain frontend-only and WDS-based | Non-goals and rollout |

This document is based on a static source trace on 2026-08-19. It plans a behavior-preserving refactor and does not
claim runtime verification of the existing connector flows.
