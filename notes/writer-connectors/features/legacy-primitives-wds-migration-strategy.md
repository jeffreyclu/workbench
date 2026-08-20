# Connectors legacy primitives to WDS: migration strategy

Status: proposed  
Scope: frontend-only; strategy for a later implementation; no WDS changes  
Research date: 2026-08-19  
Pinned WDS package inspected: `@writercolab/fe.wds@1.105.1`

## Outcome

Treat the three legacy primitives differently rather than forcing a uniform migration:

| Legacy use | WDS finding | Decision |
| --- | --- | --- |
| Local dropdown-menu wrappers in `explore-connectors-modal.tsx` | WDS exports the complete Radix-style `DropdownMenu` family with compatible controlled-open, `asChild`, `align`, and `className` contracts. | Migrate the modal to direct WDS imports, then verify menu geometry, keyboard behavior, focus restoration, and light/dark rendering. |
| `DefaultBadge` over app-local `ui/badge` | WDS does not export `Badge`. WDS `Tag` is the closest product-semantic equivalent and supports `color="blue"`, `shape="square"`, and `size="sm"`. | Keep `DefaultBadge` as the connectors-owned product composition, but migrate its primitive to WDS `Tag` only if the WDS combination can match both existing uses in light and dark without deep internal overrides. Otherwise document a named WDS `Default/status tag` variant gap for `fe.wds`. |
| App-local `ui/scroll-area` | WDS exports no `ScrollArea`, scrollbar, or equivalent compound primitive. | Block the primitive migration on a named WDS `ScrollArea` gap. Do not change or delete the shared wrapper, and do not replace it with a plain `overflow-auto` container under this task. |

The implementation should therefore land the dropdown migration independently. The badge migration is conditional on a visual-parity checkpoint. The scroll-area item is documentation-only until `fe.wds` publishes an equivalent.

## Evidence and source-of-truth limits

- The repository's WDS skill and `frontend/docs/DESIGN_INTEGRATION.md` identify the main WDS barrel as the stable primitive API.
- The installed published package's `dist/index.d.ts` and `dist/index.js` export `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, the remaining menu family, and `Tag`.
- The same public barrel contains no `Badge`, `ScrollArea`, scrollbar, or scroll viewport export. There are no badge or scroll-area component artifacts under `dist/components/`.
- The local app Storybook has `UI/Badge`, but that story is for the legacy `frontend/src/components/ui/badge.tsx`; it is evidence of the current app-local variants, not a WDS component.
- The published internal WDS Storybook was not discoverable from the repository or the public web index during this read-only pass. The pinned published package is therefore the executable API authority for this app. Before implementation, the assignee must open the authenticated WDS Storybook and recheck `DropdownMenu`, `Tag`, `Badge`, and `ScrollArea`; if Storybook has a newer component that is not present in 1.105.1, the strategy must include the necessary WDS version upgrade rather than importing an unavailable API.

## Current behavior contracts

### Explore filters dropdown

`frontend/src/components/agents/manage-tabs/explore-connectors-modal.tsx` renders the same controlled category menu in two responsive header branches. Both use:

- `open={filterDropdownOpen}` and `onOpenChange={setFilterDropdownOpen}`
- `DropdownMenuTrigger asChild` around `CategoriesFilterIconButton`
- `DropdownMenuContent align="end"`
- a fixed `w-62 h-128` content box with custom horizontal/vertical padding and hidden native scrollbar
- `ConnectorsNav` as the content, preserving its category-toggle behavior

WDS is built on the same Radix primitive and accepts these contracts. This makes the import migration behaviorally viable. Its default visual treatment differs from the local wrapper: WDS uses its own semantic menu colors, `rounded-md`, WDS menu shadow, larger base typography, and different default padding, while the local shim uses legacy popover tokens, `rounded-xl`, `shadow-md`, and `p-1`. The existing usage classes override padding and size but not every default. Visual parity must therefore be measured, not inferred from API compatibility.

Do not convert this to `SimpleDropdownMenu`: the content is an interactive `ConnectorsNav` composition, not a flat WDS options array.

### DefaultBadge

`frontend/src/components/connectors/default-badge.tsx` is a product-level concept shared by exactly two consumers:

1. `frontend/src/components/agents/manage-tabs/connector-table-row.tsx` — `Default`
2. `frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx` — `Default Profile`, used as the trigger for explanatory WDS tooltip content

The current wrapper uses the app-local `Badge` `primary` variant and overrides it to an uppercase, compact, square-cornered blue label with custom tracking and spacing. Neither consumer passes primitive-specific props today; both pass only children. This means `DefaultBadge` can narrow its public contract to the WDS `Tag` props needed by the product concept without breaking known callers.

Recommended candidate:

```tsx
<Tag color="blue" shape="square" size="sm">…</Tag>
```

The wrapper should remain in `components/connectors/`: `Default` is a connectors product meaning, while `Tag` owns the primitive rendering. Keep uppercase and tracking as composition-level typography only if the authenticated WDS Storybook confirms no native variant. Do not copy the legacy badge CVA or introduce a new local primitive.

The migration stops if WDS `Tag` cannot preserve the compact height, blue foreground/background role, tooltip-trigger layout, or dark-mode contrast without overriding WDS internals or hardcoding raw palette values. Record that as:

- WDS gap: compact blue square `Default/status tag` variant
- Closest fallback: existing connectors `DefaultBadge` over the legacy local `Badge`
- Owner: `fe.wds`

### ScrollArea

The shared wrapper is a Radix Scroll Area composition with a focusable full-size viewport, custom vertical scrollbar/thumb, and corner. Connector-related consumers are:

- `frontend/src/components/agents/manage-tabs/explore-connectors-modal.tsx` — category sidebar and connector grid (two instances)
- `frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx` — profile/tool preview body

It has 41 instances across 26 consumer files. The 22 consumer files outside `components/agents/manage-tabs/` are:

- `frontend/src/components/document-preview/components/view-count-badge.tsx`
- `frontend/src/components/file-renderers/code/code-renderer.tsx`
- `frontend/src/components/file-renderers/tar/tar-archive-renderer.tsx`
- `frontend/src/components/playbooks/playbook-detail-view.tsx`
- `frontend/src/components/playbooks/playbook-run/playbook-run-dialog-legacy.tsx`
- `frontend/src/components/playbooks/playbook-run/playbook-run-preview-panel.tsx`
- `frontend/src/components/playbooks/playbook-v3/preview-tab.tsx`
- `frontend/src/components/thread/chat-input/combined-selector.tsx`
- `frontend/src/components/thread/content/renderers/canvas-preview.tsx`
- `frontend/src/components/thread/tool-views/command-tool/TerminateCommandToolView.tsx`
- `frontend/src/components/thread/tool-views/datetime-tool/DateTimeToolView.tsx`
- `frontend/src/components/thread/tool-views/file-operation/FileEditToolView.tsx`
- `frontend/src/components/thread/tool-views/get-app-details/get-app-details.tsx`
- `frontend/src/components/thread/tool-views/get-current-agent-config/get-current-agent-config.tsx`
- `frontend/src/components/thread/tool-views/image-edit-or-generate/ImageEditGenerateToolView.tsx`
- `frontend/src/components/thread/tool-views/search-mcp-servers/search-mcp-servers.tsx`
- `frontend/src/components/thread/tool-views/str-replace/StrReplaceToolView.tsx`
- `frontend/src/components/thread/tool-views/streaming-ask-knowledge-graphs-tool/StreamingAskKnowledgeGraphsToolView.tsx`
- `frontend/src/components/thread/tool-views/voice-tool/VoiceToolView.tsx`
- `frontend/src/components/thread/tool-views/web-scrape-tool/WebScrapeToolView.tsx`
- `frontend/src/components/thread/tool-views/web-search-tool/WebSearchToolView.tsx`
- `frontend/src/components/ui/tool-view/tool-view-content.tsx`

The other two manage-tabs consumers are `skill-editor-dialog.tsx` and `skill-viewer-dialog.tsx`. Because WDS has no equivalent and the wrapper is shared broadly, changing its implementation would exceed the connectors-only scope and create an unbounded regression surface. Leave the file and all imports unchanged.

Write the upstream gap for `fe.wds` with these required capabilities:

- compound root/viewport/vertical scrollbar/thumb/corner behavior
- forwarded Radix-compatible root props and refs
- class hooks for root and scrollbar without deep DOM selectors
- full-height flex-child support (`h-full`, `min-h-0`, `flex-1`)
- max-height content support
- keyboard/focus-visible viewport behavior
- semantic light/dark scrollbar tokens
- optional horizontal orientation, even though the current wrapper defaults to vertical

## Recommended implementation sequence

1. Capture a baseline of the Explore filter menu and both `DefaultBadge` uses in light and dark. Include the menu closed/open, category selected/unselected, table row, and Preview tooltip-trigger states.
2. Recheck the authenticated published WDS Storybook against the pinned package. Record story URLs/names and exact supported variants. If the package must be upgraded, split that upgrade from the connector changes and follow the pinned-WDS dependency workflow.
3. Migrate only the three dropdown imports in `explore-connectors-modal.tsx` from the local shim to the main WDS barrel. Preserve controlled state, `asChild`, alignment, dimensions, and responsive duplication. Do not edit or delete the shared local dropdown file because it has other consumers outside this scope.
4. Compare the open menu against baseline in light/dark and at the responsive branches that show it. Prefer WDS defaults. Add only approved composition-level layout classes if required; if matching the required visual needs deep overrides of WDS internals, stop and document the missing WDS menu variant.
5. Trial `DefaultBadge` internally over WDS `Tag` with the Storybook-supported `blue`/`square`/`sm` combination. Verify both consumers before changing its exported prop type. Land only if the table cell and tooltip trigger retain geometry and visual meaning in both themes. Otherwise revert the trial and file the named `Default/status tag` gap.
6. Do not modify `scroll-area.tsx`. Add the named WDS gap to the implementation report and link the upstream `fe.wds` issue when one exists.

## Verification contract

Static checks:

- `explore-connectors-modal.tsx` has no import from `@/components/ui/dropdown-menu` after migration.
- If the badge migration lands, `default-badge.tsx` has no import from `../ui/badge`, and both known consumers compile unchanged or with an intentionally narrowed prop contract.
- `scroll-area.tsx` and its 26 consumer files are byte-identical under this task.
- No WDS source, generated client, backend file, or dependency version changes unless a separately approved WDS package upgrade is required.
- Run frontend lint and typecheck using the repository's current commands.

Interaction checks:

- Filter trigger opens with pointer, Enter, and Space; arrow-key navigation remains within the menu composition where applicable; Escape closes; focus returns to the trigger.
- Category selection, `All` reset behavior, category count, controlled open state, search, pagination reset, and both responsive header branches remain unchanged.
- The menu remains bounded to the available viewport and its long category list scrolls.
- `DefaultBadge` remains visible in table and Preview; the Preview tooltip remains keyboard reachable and restores focus.

Visual checks:

- Capture before/after screenshots in light and dark for the Explore modal menu, connector table default row, and Preview default-profile state.
- Compare size, padding, radius, typography, foreground/background, border/shadow, focus ring, selected/hover states, and clipping/scrollbar behavior.
- Do not report parity from code inspection alone. Any unresolved mismatch must be named as a WDS gap with the closest fallback and `fe.wds` as owner.

## Risks and non-goals

- Direct WDS dropdown imports preserve interaction APIs but intentionally expose WDS visual defaults; unnoticed menu geometry drift is the primary risk.
- `Tag` is semantically close to the Default marker but is not an API-identical `Badge`. Passing through the entire old `Badge` prop surface would preserve a contract no consumer needs and should be avoided.
- Deleting either shared legacy file is out of scope. This work removes connectors' dependency where possible; it does not complete repository-wide legacy primitive cleanup.
- Replacing Radix Scroll Area with CSS overflow is not equivalent: it changes viewport, scrollbar, focus, and sizing behavior and would bypass the explicit WDS-gap policy.
- No connector data, query, permission, pagination, modal-flow, or backend behavior belongs in this migration.

