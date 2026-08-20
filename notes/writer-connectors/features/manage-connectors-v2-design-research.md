# Manage Connectors V2 design research

Status: research complete; no production code changed  
Source design: Figma file `G69xuyQN9HMmjhKe8c6zbn` (WRITER-Agent), section `31768:101793` (Manage Connectors V2)  
Source read: live `get_design_context`, metadata, and screenshots on 2026-08-19  
Code comparison: static read of `frontend/src/components/agents/manage-tabs/` on 2026-08-19; not verified against a running application

## Outcome

Manage Connectors V2 is a structural redesign, not a restyle of the existing table. The target page is a responsive card directory split into **Connected** and **Available to connect** sections. It replaces table columns and page-number pagination with a search/sort/action toolbar, sectioned cards, and document scrolling. The implementation should preserve the current provider-neutral connection workflows while moving presentation behind a card-oriented view model.

This document is research input for a tech spec. It records the verified design-to-code delta, ownership, data constraints, sequencing, acceptance criteria, and test matrix. It does not authorize changes to WDS primitives or removal of the `connector-gateway` flag.

## Verified design inventory

The top-level Figma section contains more than one happy-path mockup:

- populated desktop page (`31776:134825`), 1400 × 922;
- desktop empty-section treatment (`32193:29266`), 1400 × 922;
- long, scrolling page (`32171:34527`), 1400 × 922;
- maximum-width layout (`32171:37614`), 2400 × 900;
- intermediate layouts at 1031 × 900 (`32171:37169`) and 768 × 900 (`32171:37172`);
- minimum layout at 640 × 900 (`32171:37175`);
- connector-card light/dark, connected/disconnected, default/hover/menu states (`32171:30524`);
- sort/filter menu, row action menus, status/default tooltips, and success/error toasts;
- OAuth/info (`32193:26654`), success (`32193:26677`), and error (`32193:26706`) connection dialogs;
- an onboarding/empty-state dialog with connector artwork and confirmation controls (`32220:35932`).

The page copy in the populated frame is:

- heading: **Connectors**;
- description: **Third-party apps Writer Agent can use when responding.**;
- search placeholder: **Search Connectors**;
- sections: **Connected** and **Available to connect**;
- sort default: **Sort by Name A to Z**;
- the **Available to connect** toolbar action is annotated as a scroll anchor to that section.

## Current page versus target design

| Area | Current implementation | Figma target | Required change |
|---|---|---|---|
| Primary layout | One WDS table in `connectors-tab.tsx` | Two named card sections | Replace table projection with `connected` and `available` groups while preserving one source list and connector identity. |
| Connector content | Connector, Default, Tools Enabled, Description, Status, Actions columns | 72px cards with 40px logo, profile name, optional Default chip, status/action area | Move secondary details into the card/details flow; do not silently discard tools, descriptions, status, or profile actions. |
| Connected state | Status cell and menu inside every row | Pulsing status indicator plus overflow menu | Keep semantic status text available to assistive technology; menu must retain view details, set default, add profile, disconnect, and revoke rules where applicable. |
| Available state | Disconnected row remains in the same table | Separate Available section with Connect button and overflow action | Project availability explicitly and keep OAuth/API-key/organization-profile routing unchanged. |
| Search | WDS `SearchInput`, placeholder “Search” | WDS-linked SearchInput, placeholder “Search Connectors” | Update copy and filter both sections from the same query. Empty search results must not be confused with an account having no connectors. |
| Sort/filter | Clickable Connector and Status headers | Dedicated 181 × 40 dropdown; default “Name A to Z” | Move sorting to a keyboard-operable menu. Preserve deterministic name and status ordering; tech spec must enumerate supported options from the Figma menu before coding. |
| Jump action | Explore action opens a catalog modal | “Available to connect” scroll anchor | Use an in-page anchor/focus target. Whether Explore remains as a separate catalog entry is a product decision; do not delete the existing permission-gated flow without confirmation. |
| Pagination | Client slice of 25 plus sticky WDS Pagination | Continuous card document/scroll frame; no page-number control shown | Remove visible pagination only after data loading is redesigned. Current code drains all API pages first, so infinite loading and server/query ownership need a separate contract. |
| Empty states | Whole-page `ConnectorsEmptyState`; search-specific Paper illustration | Independent 217px empty cards under each section | Model section emptiness separately: no connected connectors, no available connectors, neither, and no search matches. |
| Responsive | Table has no page-specific responsive reflow | Four-column max, two-column normal/intermediate, one-column minimum | Implement CSS-grid breakpoints driven by available content width. Cards remain 72px high, at least 300px wide where space permits, and become a single ~500px content column at the 640 frame. |
| Theme/states | Existing WDS table theming | Explicit light/dark card variants; hover and open-menu variants | Use semantic WDS/application tokens. Do not copy raw Figma hex values where project tokens exist. |
| Feedback | Inline partial-load notices; existing toasts from mutations | Success/error/info toasts and connection dialogs | Preserve visible loading/error states and map existing workflow results to the designed feedback. Do not make errors toast-only when recovery is required. |

## Card contract inferred from Figma

The card is the core new presentational unit:

- outer box: 72px high, 12px radius, 16px padding, one-pixel semantic border;
- normal desktop width: 500px; grids use a 15–16px column gap and 16px row gap;
- minimum width in the component definition: 300px;
- logo tile: 40 × 40; preserve the outer tile and inner logo geometry separately;
- title/profile: 14px medium, single-line ellipsis;
- Default treatment: compact 24px pill, visible only where the current profile/default rules allow it;
- available card: 32px Connect button and 32px overflow action;
- connected card: status indicator and 32px overflow action;
- hover changes the available Connect button to the primary treatment;
- open-menu state uses the primary/blue card border;
- both light and dark treatments are designed.

Implementation recommendation: add a Manage Connectors opt-in variant to the existing shared `ConnectorIcon`, and create a page-local connector card. Do not globally change `ConnectorIcon` sizing/radius; its verified blast radius is 21 usages in 16 production files. Normalize signed custom-logo resolution before applying the new variant so an unresolved `logo_...` storage path never reaches `<img>`.

## Responsive behavior

The frame evidence implies layout by content width, not device labels:

- 2400px frame: four 500px cards per row;
- 1400px frame: two 500px cards per row inside a 1015px content region;
- 1031px and 768px frames: two flexible cards per row (approximately 434–436px and 304px respectively);
- 640px frame: one card per row in an approximately 500px content region.

The tech spec should define the grid with `minmax(300px, 1fr)` and verify the exact transition against the real Customize shell. At minimum width, toolbar controls must wrap or compact without horizontal overflow, while the Available anchor and sort control remain keyboard reachable. The Figma minimum is 640px; behavior below that width is not explicitly designed and must be specified rather than guessed.

## Interaction and state requirements

### Search, sort, and navigation

- Search applies to connector name, display name, profile name, and description, matching current behavior.
- Changing search or sort must not reset connection/auth state or close an active dialog.
- The Available action scrolls to and focuses the Available section heading with reduced-motion-safe behavior.
- Sort must expose its current value and be usable with keyboard, Escape, and focus restoration.
- Card clicks may open details, but nested Connect/menu controls must not trigger the card action.

### Connection lifecycle

The existing workflows remain authoritative in both `connector-gateway` states:

- consent can defer and resume connect/enable;
- OAuth and user API-key routes remain distinct;
- organization-profile connections stay deduplicated while pending;
- legacy post-auth enablement and gateway post-auth behavior stay distinct;
- revoke must not delete a profile if config cleanup fails;
- success, error, and in-progress dialogs need accessible titles, descriptions, focus trapping, Escape/close behavior, and visible recovery actions.

The Figma connection dialogs show an info state (“Log into … / Return here after you’ve signed in”), a success state with automatic-close copy, and an error state with reason text and recovery actions. Existing auth polling should drive these views rather than introducing a second state machine.

### Loading and failure

- Initial load: card-grid skeleton matching the two-section structure.
- Later-page load: keep rendered cards stable and show an in-context progress indicator.
- Later-page failure: keep loaded cards, explain incomplete results, and expose Retry.
- Logo signing failure: show the existing connector fallback, never a broken image or raw storage path.
- Mutation failure: keep the card’s prior state and provide recoverable feedback.
- Empty search: show a search-specific result state without replacing the account-level empty-section cards.

## Data and architecture constraints

The card redesign must not hide existing connector-gateway fidelity problems.

- `enabled` is invented as `true` in the gateway compatibility adapter; it is not a trustworthy native profile field.
- `totalToolCount` is derived from `allowedTools.length || -1`; it is not a reliable total for an empty/all-tools profile.
- provider attribution survives conditionally, but tool schemas, annotations, richer metadata, timestamps, ownership, tenant modes/patterns, and several catalog fields are dropped before the UI.
- any design requirement using a conditional/no-go field must first define a CG-native view model or an explicitly enriched compatibility contract behind the existing flag.

Use `docs/initiatives/connectors/connector-gateway-adapter-field-loss.md` as the authoritative field ledger. Do not reproduce its tables here.

The current page also drains every server page before client search/sort/pagination. Removing visible pagination without fixing that behavior would preserve the worst scaling characteristic while making loading less legible. The tech spec must choose and document one of these:

1. server-backed/infinite loading with server search/sort and explicit incomplete-result states; or
2. a bounded catalog contract proving the complete data set is intentionally small.

## Ownership and proposed implementation seams

| Responsibility | Target owner |
|---|---|
| Flag, queries, permissions, provider-neutral operations | `use-connectors-tab-data.ts` proposed by `connectors-tab-decomposition.md` |
| Search, sort, connected/available grouping, list projection | `use-connectors-list-state.ts` |
| Consent, auth, profile actions, modal transitions | `use-connectors-modal-orchestration.ts` |
| Toolbar, section headings, grids, empty/loading/error states | replace the proposed table shell with a card-oriented `connectors-page-shell.tsx` (final name for tech spec) |
| Individual card and nested actions | new page-local `connector-card-row.tsx` or equivalent under `manage-tabs/` |
| Status presentation | reuse `connector-row-status.tsx` behavior through a card-compatible API; do not duplicate status rules |
| Logo source/fallback | shared `connector-icon.tsx` opt-in variant plus normalized `resolveConnectorLogo` flow |
| Details/tools | existing `preview-connector-modal.tsx`; apply the separate warm-cache fetch-deduplication plan |
| Connection dialogs | existing OAuth/API-key/consent owners, adapted to the designed states |

The existing behavior-preserving decomposition remains useful, but its presentation endpoint must become a card shell rather than the table shell originally proposed. Land extraction before visual replacement so behavior changes and design changes remain independently reviewable.

## Implementation sequence for the tech spec

1. **Lock data contracts.** Resolve infinite-loading/search/sort ownership and classify every displayed field against the gateway fidelity ledger.
2. **Extract behavior.** Land list/data/modal seams without changing the table UI; verify both feature-flag states.
3. **Normalize shared assets.** Fix signed-logo resolution and add the opt-in ConnectorIcon variant without changing other consumers.
4. **Introduce card primitives.** Build and test connected/available/default/hover/menu/light/dark card variants using WDS tokens.
5. **Replace the page projection.** Add toolbar, sections, responsive grids, anchor behavior, and section-specific empty/loading/error states.
6. **Reconcile dialogs and feedback.** Adapt existing auth state to the info/success/error designs and preserve recovery behavior.
7. **Remove obsolete table pagination only after the new data-loading contract is live.**

Do not combine steps 1–2 with the visual rewrite. Do not edit WDS source in this repository; named primitive gaps belong in `fe.wds`.

## Acceptance criteria

- Populated connectors render in mutually exclusive Connected and Available sections from one provider-neutral data source.
- Cards match the verified 72px/40px/16px/12px geometry and have light, dark, hover, menu-open, connected, available, and default-profile states.
- Layout renders four, two, two, and one columns at the verified Figma widths without horizontal overflow.
- Search and sort operate across both sections and expose accessible names/current values.
- Available action scrolls/focuses the Available heading and respects reduced motion.
- All existing connect, consent, OAuth, API-key, enable/disable, default, details, add-profile, disconnect, and revoke rules remain correct with the flag on and off.
- Each section has a distinct empty state; empty search is distinct from empty account data.
- Initial loading, later-page loading, later-page failure/retry, logo failure, and mutation failure remain visible and recoverable.
- Connector logos use resolved URLs or the established fallback; no raw `logo_...` path renders.
- No non-opted-in `ConnectorIcon` consumer changes visually.
- No CG-native field is represented from an invented or ambiguous compatibility value without an explicit contract decision.
- Table/page-number UI is removed only after the replacement data-loading behavior is verified.

## Test matrix

| Layer | Required coverage |
|---|---|
| List projection | connected versus available classification; stable name/status sort; search across four current fields; section counts; search reset behavior |
| Card unit | all state/theme variants; default visibility; status text; Connect/menu nesting; logo URL/fallback; truncation; accessible name |
| Page shell | four/two/one-column layouts; toolbar wrapping; Available anchor/focus; section empties; no-search result; loading/error/retry |
| Orchestration | consent defer/resume; OAuth; API key; organization connect deduplication; legacy/gateway post-auth difference; set default; disconnect; revoke failure guard |
| Dialogs | info/success/error rendering; reason copy; automatic-close announcement; focus trap/restoration; Escape; retry/close actions |
| Data loading | initial page, subsequent page, stale/incomplete result, retry, server search/sort if selected, no duplicate or missing cards |
| Regression | both `connector-gateway` values; warm/cold Preview provider/logo data; all non-opted-in ConnectorIcon consumers unchanged |
| Accessibility | headings/regions, keyboard toolbar/menu/card actions, visible focus, status announcements, reduced motion, contrast in light/dark |

Implementation verification should include focused Vitest/component coverage, visual comparisons at 2400, 1400, 1031, 768, and 640 widths, keyboard checks, light/dark checks, and the repository’s normal frontend lint/typecheck/test commands.

## Open decisions the tech spec must resolve

1. Does the Available scroll anchor replace the permission-gated Explore catalog action, or coexist with it?
2. What exact sort options are present in the Figma menu beyond the verified default “Name A to Z”?
3. What is the supported behavior below the smallest designed 640px frame?
4. Is the connector catalog bounded, or must the page adopt server-backed infinite loading/search/sort?
5. Which current table-only details remain on the card versus move exclusively into Preview?
6. Does the onboarding/empty-state dialog belong to this route’s first-use flow, and what persists its checkbox choice?
7. Which Figma connection-dialog states replace existing modals versus restyle them?

These decisions materially change implementation and should be settled in the tech spec rather than inferred during coding.

## Related research

- `docs/features/connectors/connectors-tab-decomposition.md`
- `docs/features/connectors/connector-icon-change-contract.md`
- `docs/features/connectors/preview-connector-modal-fetch-deduplication.md`
- `docs/features/connectors/legacy-primitives-wds-migration-strategy.md`
- `docs/initiatives/connectors/connector-gateway-adapter-field-loss.md`
- `~/notes/knowledge/writer-connectors-page-map.md`

## Verification boundary

Verified directly from Figma: the section/frame inventory, page copy, two-section card layout, card geometry and variants, responsive column counts, scroll example, menus/tooltips/toasts, and info/success/error dialog presence. Verified statically from code: current table structure, client search/sort/page projection, eager page draining, feature-flag/provider seams, modal/action owners, and current logo flow.

Not verified: runtime rendering of the current page, backend catalog size/performance, exact behavior below 640px, and product intent for the open decisions above.
