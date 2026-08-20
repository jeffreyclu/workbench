# PreviewConnectorModal fetch deduplication

Status: proposed  
Source: manual finding  
Scope: frontend-only; tech-spec input; no implementation in this change  
Static trace date: 2026-08-19

## Outcome

Opening Preview from an already-rendered connector row or Explore card should reuse the provider attribution and signed
logo URL that the opener already has. `PreviewConnectorModal` should keep its existing queries as conditional fallbacks
so a cold or independently opened Preview still resolves both values.

The recommended contract is an explicit preview-selection payload owned by the modal orchestrator:

```ts
interface ConnectorPreviewSelection {
  config: UserProfileConnector;
  catalogApp?: ConnectorApp;
  resolvedLogoUrl?: string | null;
}
```

This keeps server state in TanStack Query while passing a small, already-derived interaction snapshot to the modal. It
does not copy a catalog into local state, introduce a second cache, or alter the tool query.

## Current behavior and cause

`ExploreConnectorsModal` fetches the catalog with `useListMcpGatewayApps` using page, page size, search, and categories
at `frontend/src/components/agents/manage-tabs/explore-connectors-modal.tsx:82`. The clicked card still has its complete
`ConnectorApp`, including `provider` and `logo`, in `ConnectorLibrary` at
`frontend/src/components/agents/manage-tabs/connector-library.tsx:71`.

The click path converts that app to `UserProfileConnector` and discards the catalog object at
`frontend/src/components/agents/manage-tabs/connector-library.tsx:77`. `ConnectorsTab` then stores only the selected
profile ID at `frontend/src/components/agents/manage-tabs/connectors-tab.tsx:304`. Preview consequently cannot see the
provider that was present on the clicked card.

Preview compensates by calling `useListMcpGatewayApps` with the connector name as a search at
`frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx:148`. That is a different query from the Explore
page because the generated key includes the complete request options, including pagination and search. It therefore
issues another catalog request instead of reusing the Explore observer's result.

The same loss happens for the logo. `ConnectorLibrary` batch-signs the rendered catalog/profile logo paths at
`frontend/src/components/agents/manage-tabs/connector-library.tsx:31`, and the main table batch-signs its profiles at
`frontend/src/components/agents/manage-tabs/connectors-tab.tsx:168`. Preview receives neither resolved URL, so
`useResolvedLogoUrl` mounts a single-path query at
`frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx:162`. Its key
`['signed-logos', orgId, [logoPath]]` differs from a page batch key containing multiple sorted paths.

## Query-key constraints

The proposal must not assume one hand-written app-list key:

| Path | Catalog key owner | Cached value caveat |
| --- | --- | --- |
| `connector-gateway` on | generated `getApiConnectorGatewayV1OrganizationByOrgIdConnectors` key from the complete request options | TanStack Query stores the raw CG response; `adaptCgV1ConnectorsToAppsResponse` is an observer `select` |
| `connector-gateway` off | generated `getApiMcpGatewayV2OrganizationByOrgIdApps` key from the complete request options | cache contains the legacy apps response |
| signed logos | `['signed-logos', orgId, sortedCustomPaths]` | each distinct path set is a distinct cache entry |

For these reasons, `queryClient.getQueryData` against one exact key is insufficient. A cache-wide selector would need to
understand both generated key formats, inspect an arbitrary number of paginated/search entries, adapt raw CG values,
and separately scan subset/superset logo keys. That creates a second implicit data-access contract. Passing the data
already used to render the clicked row/card is the smaller and more maintainable boundary.

## Proposed data flow

### Explore card

When a card is clicked, `ConnectorLibrary` should send:

- the existing or synthesized `UserProfileConnector`;
- the card's original `ConnectorApp` (the authoritative provider for this interaction); and
- the already resolved logo URL from its batch map.

`ConnectorsTab` stores this payload as the current preview selection and opens Preview. No app-list request or logo-sign
request is needed while these optional values are present.

### Existing connector table row

The table row should send its `UserProfileConnector` and the `logoUrl` already supplied by `ConnectorsTab`. The profile
shape does not currently expose provider, so provider attribution uses the fallback unless a catalog app is also
available from the current interaction/cache. This is not a duplicate request when no catalog request has supplied the
provider.

If the product requires every warm table-row Preview to avoid a request even when Explore was never opened, enrich the
page-level data owner with catalog metadata first; do not invent a provider from the profile or display name.

### Preview fallback

Preview derives values in this order:

1. Use `selection.catalogApp?.provider` and `selection.resolvedLogoUrl` when supplied.
2. Enable the existing name-filtered `useListMcpGatewayApps` query only when provider data is absent and Preview is open
   with a connector name and organization ID.
3. Enable single-logo signing only when no resolved URL was supplied and the connector logo is a custom logo path.
4. Preserve `resolveConnectorLogo` behavior for built-in URLs, missing logos, and an unsigned custom path.

The fallback should remain a normal TanStack Query query, not an effect-driven imperative fetch. This preserves request
deduplication, retry/error behavior, stale-time behavior, and both generated catalog implementations.

Provider labeling remains unchanged: only tools with `protocol === 'MCP_REMOTE'` use the catalog provider; all other
connectors render `BRANDING.COMPANY_NAME`. Loading UI should wait only for data that is actually needed. In particular,
a supplied provider must prevent the provider skeleton from being coupled to a disabled fallback query.

## Tool-query non-regression boundary

Do not change `useListTools`, its arguments, or the tool-row derivation. The two existing paths must remain:

- `connector-gateway` on: generated connector tools-list query selected through `adaptCgV1ToolsToLegacy` at
  `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts:174`;
- `connector-gateway` off: `['mcp-gateway', 'v3', 'functions-list', orgId, teamId, appId, profileId]` at
  `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts:189`.

The partner-built decision may continue to derive from the unchanged tool result. Tool filtering, active ordering,
pagination, toggles, loading, retry, and empty/error states are outside this change.

## Ownership and expected files

| Concern | Owner | Expected change |
| --- | --- | --- |
| Preview selection and modal opening | `connectors-tab.tsx` or the planned `use-connectors-modal-orchestration.ts` extraction | store/pass `ConnectorPreviewSelection` rather than only a profile ID |
| Explore click data | `connector-library.tsx` and `explore-connectors-modal.tsx` | return the clicked app and resolved logo with the profile |
| Table click data | `connector-table-row.tsx` | return the row's already-resolved logo with the profile |
| Conditional cold fallback | `preview-connector-modal.tsx` | accept optional warm metadata and gate the existing queries |
| Query/signing policy | existing `use-gateway.ts` and `use-organization-signed-logo.ts` owners | reuse; avoid a second feature-local fetch implementation |

If the planned `ConnectorsTab` decomposition lands first, the selection payload belongs in
`use-connectors-modal-orchestration.ts`; the presentation components should only emit it.

## Acceptance criteria and test contract

| Acceptance criterion | Verification |
| --- | --- |
| Warm Preview from Explore makes no new app-list request | Render Explore with a resolved apps query, click a card, open Preview, and assert the app-list hook's fallback is disabled/no second request occurs |
| Warm Preview reuses the batch-signed logo | Seed/pass the resolved card logo and assert the single-path signing fallback is disabled while `ConnectorIcon` receives the same URL |
| Cold Preview still shows attribution and logo | Open Preview without optional metadata, resolve the filtered catalog and signing queries, and assert the provider label and logo render |
| Cache eviction still recovers | Remove/expire catalog and signed-logo entries before opening without optional metadata; assert both fallback queries run and render their results |
| Writer-built labeling is unchanged | With non-`MCP_REMOTE` tools, assert `BRANDING.COMPANY_NAME` regardless of catalog provider |
| Partner labeling is unchanged | With an `MCP_REMOTE` tool and provider metadata, assert that provider is rendered |
| Both feature-flag states retain tool rows | Parameterize Preview coverage over `connector-gateway` on/off and assert identical observable tool names, active state, ordering, toggles, and pagination |
| Loading is dependency-specific | Warm metadata does not show the provider skeleton because the disabled fallback is pending; cold metadata does show it until attribution resolves |

Tests should focus on the unique regression: query enablement and rendered output. Do not assert generated query-key
internals in component tests. A focused hook test is appropriate only if conditional fallback selection is extracted
into a shared hook.

## Risks and tradeoffs

- The optional interaction snapshot can become stale if catalog metadata changes while Preview is open. This matches the
  card the user clicked and is bounded by modal lifetime; a later invalidation/reopen supplies fresh data.
- Adding provider directly to `UserProfileConnector` would blur catalog and profile contracts and require adapter/API
  changes in both flag paths. The selection payload avoids that widening.
- Scanning all React Query entries appears generic but couples feature code to generated key serialization and CG's raw
  cache shape. It is not recommended unless a shared catalog cache abstraction is introduced for broader use.
- Table-origin Preview cannot avoid its first provider request when no catalog data exists. That request is the cold
  fallback required by the task, not the redundant Explore-to-Preview request this change removes.

## Verification for this document

This proposal is based on a static source trace only. No application code, generated code, tests, query caches, or
runtime behavior were changed. Implementation verification must include React Query devtools/network observation for
warm and cold entry, plus the repository's frontend checks appropriate to the touched files.
