# Connector Gateway adapter field-loss inventory

> Verification status: static frontend trace performed 2026-08-19. No runtime flows or backend behavior were verified. Authoritative sources are `frontend/src/hooks/react-query/mcp-gateway/connector-gateway-adapter.ts`, the generated CG types, and `frontend/src/types/connector-profile.ts`.

## Purpose

The `connector-gateway` feature-flag path adapts CG V1 responses into legacy frontend contracts. This lets the existing Connectors UI serve both backends, but it is a lossy boundary: a field present in CG is not necessarily available to `ConnectorsTab`, Explore, or Preview. Treat this inventory as a design gate. A design may depend directly only on fields marked **GO** below.

Do not remove the legacy response shape while `connector-gateway` remains flagged. If a design needs a **CONDITIONAL** or **NO-GO** field, the tech spec must first define either a parallel CG-native view model or an explicitly enriched compatibility contract behind the existing flag.

## Fidelity vocabulary

- **preserved**: same meaning and value survives.
- **renamed**: value survives under a legacy name or encoding.
- **derived**: inferred from one or more CG fields; may not retain all source semantics.
- **defaulted**: invented because the legacy contract requires a value.
- **dropped**: CG supplies the value, but the adapter discards it.
- **endpoint-absent**: the legacy concept has no source field in this CG response.

## Transformation coverage

All adapter transformations are covered here: `mapAuthModeToSecurityScheme`, `mapConnectionStatusToAuthenticated`, `mapConnectionStatusToLegacy`, `toLegacyToolName`, `fromLegacyToolName`, `adaptCgV1ProfileToLegacy`, `adaptCgV1ProfilesResponse`, `extractOAuthUrlFromConnectResponse`, `toConnectorResponse`, `adaptCgV1ConnectorToApp`, `adaptCgV1ConnectorsToAppsResponse`, `deriveProtocol`, `deriveProtocolData`, `adaptCgV1ToolsToLegacy`, and `buildSyntheticConfig`.

## Organization profiles → `UserProfileConnector`

Response `totalCount` and `pagination` are preserved. Each result row is adapted as follows.

| CG source | Legacy output | Fidelity | Caveat / current consumer |
|---|---|---|---|
| `id` | `id`, sometimes `profileId` | preserved/derived | Row identity and mutations; `profileId` becomes `null` for org-wide auth. |
| `connectorId` | `appId`; connector-name fallback | renamed | Used to associate profiles and apps. |
| `name`, `displayName`, `description` | profile name; connector display-name fallback; description | preserved/fallback | Search and table/Preview copy (`connectors-tab.tsx:221-234`, `connector-table-row.tsx:110-122`). |
| `status` + `authMode` | `status`, `authenticated` | derived | Status normalization defaults unknown states to `PENDING`; `authMode: none` treats non-error unknown states as authenticated. Connection UI consumes both. |
| `authMode` | `securityScheme` | derived | `none/api_key/code_grant/dcr/client_credentials/http_basic` map to legacy schemes; unknown modes become `no_auth`, losing the unknown distinction. |
| `orgWideAuth` | `credentialLevel`, `profileId` | derived | Organization vs user credential behavior. |
| `writerManagedCredentialId` | `credentialManager` | derived | Presence becomes `WRITER`; absence becomes `ORGANIZATION`. The credential ID itself is dropped. |
| `allowedTools` | `allFunctionsEnabled`, `enabledFunctions`, `totalToolCount` | derived/ambiguous | Empty means “all enabled”; tool names become uppercase `__` form. `totalToolCount` is `length || -1`, so it is not a real catalog total. Table and Preview consume it (`connectors-tab.tsx:162-165`, `connector-table-row.tsx:97-99`, `preview-connector-modal.tsx:172-178`). |
| `scopes` | `scopes`, nested connector scopes | preserved | Cast through the compatibility shape. |
| `tenantUrl`, `privateEndpointId` | same | preserved | Available to legacy consumers. |
| `teamIds`, `orgId`, `createdAt`, `updatedAt`, `createdBy` | same | preserved | `orgId` is used in row actions (`connector-table-row.tsx:169-173`); other fields were not found in the current page trace. |
| `connector.logo/name/description/displayName` | nested `connector` | preserved with fallbacks | Table, Explore, Preview identity and logo presentation. |
| `ekmVaultRef` | — | dropped | Not available through the legacy result. |
| `oauthDiscoveryOverride` | — | dropped | Cannot drive OAuth discovery UI through this boundary. |
| `additionalHeaders` | — | dropped | Cannot be displayed or edited through the adapted result. |
| — | `enabled: true` | defaulted | CG org profiles expose no native enabled field. Downstream synthetic config must not treat this as authoritative enablement. |
| — | `updatedBy: null`, `createdByTeamId: null` | defaulted | Ownership detail is invented/unknown. |
| — | `visibility: PRIVATE_ORGANIZATION` | defaulted | Not sourced from the profile endpoint. |

`toLegacyToolName` converts dotted CG names such as `google_drive.upload_file` to `GOOGLE_DRIVE__UPLOAD_FILE`. `fromLegacyToolName` performs the reverse before selected-tool mutations (`use-cg-connectors.ts:123-131`). This is a compatibility encoding, not a native identifier.

## User profiles merged into organization profiles

`adaptCgV1ProfilesResponse` joins user rows first by `orgProfileId`, then by connector name for legacy shells. The user response's own `totalCount` and `pagination` are not carried into the unified result; the organization response owns those fields.

| CG user-profile source | Adapted effect | Fidelity | Caveat / current consumer |
|---|---|---|---|
| `id` | `userProfileId` | renamed | Used to identify the user's connection. |
| `orgProfileId` | join key | preserved for joining | Removed from the final legacy row. |
| `status` | overrides `status` and `authenticated` | derived | Missing match forces unauthenticated `PENDING` and clears `profileId`. |
| `selectedTools` | overrides enabled/all-functions state | derived | Empty means all tools; names are legacy-encoded. |
| `defaultProfile` | `defaultProfile` | preserved with `false` fallback | Drives default badges/actions. |
| `updatedAt` | `credentialUpdatedAt` | renamed | Non-string values become `null`. |
| `connector.name` or `name` | fallback join key | derived | Name collision/renaming can affect legacy-shell matching. |
| `orgId`, `teamId`, `description`, `createdBy`, `createdAt`, remaining connector metadata | — | dropped | Team, ownership, creation, description, logo and display metadata from the user row do not survive; the org profile remains authoritative. |

## Connector catalog → legacy v2 app

Response `totalCount` and `pagination` are preserved by `adaptCgV1ConnectorsToAppsResponse`.

| CG connector source | App output | Fidelity | Caveat / current consumer |
|---|---|---|---|
| `id`, `name`, `displayName`, `description`, `logo`, `categories`, `orgId`, `active`, `createdBy` | same | preserved | Explore/catalog identity and presentation. |
| `provider` | `provider` | preserved | Preview reads it only when a tool's derived protocol marks the connector partner-built (`preview-connector-modal.tsx:146-159`). |
| `defaultServerUrl` | `defaultMcpServerUrl` | renamed | Available in the app contract. |
| `visibility` | `visibility` | preserved/defaulted | Falsy values become `PUBLIC`. |
| `authConfig`, `authModes` | `securitySchemes`, `authModes` | renamed/preserved | DCR remains only as an auth-mode value; see defaulted `useDCR` below. |
| `dynamicTools` | `hasDynamicTools` | renamed | Capability survives. |
| `hasWriterManagedCredential` | `hasWriterManagedOAuth` | renamed/derived | Credential capability is re-expressed as OAuth-specific legacy semantics. |
| `type`, `tenantUrlPatterns`, `tenantMode`, `migratedFromLegacy`, `createdAt`, `updatedAt` | — | dropped | Designs cannot use these through `useListMcpGatewayApps`. |
| — | `appSource: null`, `version: '1.0.0'`, `tenant: ''`, `optionalTenant: false`, `privateEndpointId: null`, `functionCount: undefined`, `useDCR: false` | defaulted | These values are compatibility fillers and must not be presented as CG truth. |

## CG tools → legacy tool definitions

The tools endpoint returns an array, so there is no response pagination to preserve.

| CG tool source | Legacy output | Fidelity | Caveat / current consumer |
|---|---|---|---|
| `id`, `displayName`, `description`, `scopes`, `tags`, `active` | same | preserved | Preview searches/sorts/renders identity, copy and active state (`preview-connector-modal.tsx:178-231`). |
| `connectorId` | `appId` | renamed | Connector association. |
| `orgProfileId` | `appConfigurationId` | renamed | Preview scopes tools to the selected profile (`preview-connector-modal.tsx:172-176`). |
| `name` | uppercase `__` legacy name | renamed | Tool toggles and config membership. |
| `summary` | `summary`, default `''` | preserved/defaulted | Unknown/null summary becomes empty text. |
| `visibility` | `visibility`, default `PUBLIC` | preserved/defaulted | Falsy values lose their distinction. |
| `type` | `protocol` | derived | REST→REST, MCP→MCP_REMOTE, CODE→CODE; unknown types pass through. Preview uses MCP_REMOTE to infer partner-built attribution. |
| REST metadata `method/path/serverUrl` | `protocolData.method/path/server_url` | partially preserved | Headers, encoding, body envelope/static body, path params and query params are dropped. |
| MCP metadata `toolName/serverUrl/transport` | `protocolData.originalToolName/server_url/transport` | partially preserved | Missing server URL becomes `''`; `kind` is dropped. |
| Code metadata `fn` | `protocolData.fn` | partially preserved | `kind` is dropped. |
| `parameters`, `response` | `null` | dropped/defaulted | CG schemas exist but Preview cannot access them. |
| `annotations` (`readOnlyHint`, `idempotentHint`, `openWorldHint`, `destructiveHint`, extensions) | — | dropped | Safety/behavior badges cannot be implemented from the adapted tools. |
| `orgId`, `createdAt`, `updatedAt` | `null` | dropped/defaulted | Tenant/ownership and chronology are unavailable. |

## Connect response and event-trigger compatibility

`extractOAuthUrlFromConnectResponse` preserves `authorizationUrl` for OAuth variants and returns `undefined` for non-OAuth responses. It is consumed by the generic gateway connect flow and Google Drive compatibility flow (`use-gateway.ts:606`, `google-drive/use-connect.ts:156`). Other response fields/variants are intentionally not exposed by this helper.

`toConnectorResponse` copies only the legacy-compatible subset of already-adapted unified profiles into event-trigger `ConnectorResponseCompat`. It cannot recover anything dropped earlier. Current output includes counts/pagination; profile and connector identity; description/logo; enablement/auth/status; visibility/security/tenant/scopes; selected-tool state; credential level; teams/org/profile IDs. Fields outside that interface remain unavailable to event-trigger consumers.

## Synthetic agent config

`buildSyntheticConfig` groups profiles by connector name. Authenticated profiles contribute available IDs; any authenticated profile makes the connector enabled; an authenticated all-functions profile forces an empty tool list; selected tools are unioned otherwise; and an authenticated default profile supplies `defaultProfileId`.

The surrounding `UserAgentConfig` is entirely defaulted: `user_agent_config_id: synthetic-cg`, empty `agent_id`, zero organization/team/creator IDs, empty skills/meeting settings, and empty timestamps. It returns `null` for zero connectors. These constants exist only to satisfy downstream connection-state logic and must never be shown as source data.

## Query-boundary behavior

The primary unified-profile infinite query has no TanStack `select`, but this does **not** preserve CG data: `fetchUnifiedUserProfilesPage` calls `adaptCgV1ProfilesResponse` before returning, so React Query caches the lossy result (`use-gateway.ts:240`). By contrast, apps, tools and org-profile hooks apply explicit `select` transforms (`use-gateway.ts:129`, `:184`, `:386`). In every case the UI sees the adapted contract, not the original CG payload.

## Design go/no-go matrix

| Design requirement | Decision | Reason |
|---|---|---|
| Connector/profile identity, name, description, logo | **GO** | Preserved, with documented connector fallbacks. |
| Provider/builder attribution | **GO, narrowly** | Provider survives the app adapter; Preview currently exposes it only for derived partner protocol. |
| Selected tools and all-tools state | **CONDITIONAL** | Survives via legacy name encoding; empty means all. |
| Real profile enabled state | **NO-GO** | Endpoint absent; adapter invents `enabled: true`. |
| Real total tool count | **NO-GO** | Not provided by the profile endpoint; `allowedTools.length || -1` is ambiguous. |
| Connection/auth status | **CONDITIONAL** | Derived through lossy normalization and user/org merging. |
| Auth modes and DCR | **CONDITIONAL** | Auth modes survive in apps, but `useDCR` is hard-coded false and profile security schemes collapse modes. |
| Dynamic-tool capability | **GO** | `dynamicTools` becomes `hasDynamicTools`. |
| Tenant patterns/modes and connector type | **NO-GO** | Present in catalog response, dropped by app adapter. |
| Tool parameter and response schemas | **NO-GO** | Present in CG, replaced with null. |
| Tool safety annotations | **NO-GO** | Read-only/idempotent/open-world/destructive hints are dropped. |
| Rich REST metadata | **NO-GO** | Only method/path/server URL survive. |
| Timestamps and ownership | **CONDITIONAL/NO-GO** | Some org-profile fields survive; catalog/tool and user-profile history/ownership is dropped or defaulted. |
| Private endpoints | **CONDITIONAL** | Org-profile value survives; app-level value is always null. |
| Additional headers and OAuth discovery overrides | **NO-GO** | Present on org profiles but dropped. |
| Team scoping | **CONDITIONAL** | Org-profile `teamIds` survive; user-profile `teamId` is dropped. |

## Tech-spec rule

For every field shown in a Connectors design, cite this inventory and classify the field as GO, CONDITIONAL, or NO-GO. A CONDITIONAL or NO-GO dependency blocks faithful implementation until the spec names the data-contract change and its behavior in both `connector-gateway` flag states. Do not infer product truth from defaulted compatibility values.

