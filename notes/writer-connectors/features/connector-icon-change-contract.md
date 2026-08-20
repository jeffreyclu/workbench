# ConnectorIcon change contract

Status: proposed  
Scope: frontend-only analysis; no connector logo redesign or WDS change  
Primary component: `frontend/src/components/connectors/connector-icon.tsx`

## Decision

Extend the existing `ConnectorIcon` with an explicit, opt-in visual `variant` when the Manage Connectors V2 treatment is
implemented. Do not fork the logo rendering into a connectors-page-local component.

The existing component owns one product concept across many domains: resolve the visual priority
`logo -> logoIcon -> Plug`, size the tile and its content, apply its shape, and provide the image alternative text. A
page-local fork would duplicate that contract and make fallback, accessibility, dark-mode, and signed-logo behavior
drift. An opt-in variant keeps one owner while limiting the redesign to the three Manage Connectors usages that select
it: the table row, Preview modal, and connector library card. The current default variant must remain visually and
behaviorally unchanged.

The future variant should describe a semantic treatment, not a page name or a bundle of booleans. Its exact public name
belongs in the tech spec after the approved design is inspected. It may choose tile background, border, radius, image
fit/padding, and fallback treatment as one coherent contract. Existing `size`, `rounded`, and `className` behavior must
not be silently reinterpreted for default consumers.

## Fresh inventory and count correction

Static production-source trace performed 2026-08-19 with:

```bash
rg -l --glob '*.tsx' \
  "import \\{ ConnectorIcon \\} from ['\"](?:@/components/connectors/connector-icon|\\./connector-icon)['\"]" \
  frontend/src

rg -n --glob '*.tsx' "<ConnectorIcon\\b" frontend/src
```

The current tree has **16 direct production consumer files and 21 JSX usages**, not 22 production consumer files.
Tests and mocks are excluded. The identically named component under
`frontend/src/components/connector-ui/registry/molecules/connector-icon.tsx` is a separate renderer and is also
excluded; its `template-header.tsx` consumer is not a consumer of this contract.

No barrel re-export or aliased import of the shared component was found. This inventory is complete against the fresh
grep above, but remains unverified against runtime and feature-flag combinations.

## Current component contract

`ConnectorIcon` currently exposes:

- `logo?: string | null`
- `logoIcon?: ComponentType<{ className?: string }>`
- `displayName?: string | null`
- `size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg'`, default `xs`
- `rounded?: 'lg' | 'full'`, default `lg`
- `className?: string`
- `title?: string`

Its rendered priority and measurements are:

| Size | Tile | Image/glyph |
|---|---:|---:|
| `2xs` | 24x24 | 12x12 |
| `xs` | 40x40 | 24x24 |
| `sm` | 48x48 | 32x32 |
| `md` | 64x64 | 40x40 |
| `lg` | 80x80 | 48x48 |

`rounded="lg"` maps to `rounded-lg`; `rounded="full"` maps to `rounded-full`. The tile always applies overflow
clipping, centered flex layout, white/black background, and a gray border. Images use eager loading and
`alt={displayName || 'Connector'}`. A supplied `logoIcon` wins over the default `Plug` fallback. The fallback glyph has
no accessible name of its own; callers may provide a hover `title`, but most do not.

The only size override in production is the governance filter option, which passes `size="2xs"` and
`className="size-5 shrink-0"`. That makes the outer tile 20x20 while the inner image/glyph remains the `2xs` 12x12
size. No consumer overrides the radius through `className`.

## Complete call-site matrix

“Size/radius affected” means a change to the shared size maps, icon-size maps, or radius maps would visibly change the
usage. “Signed path affected” means an org-uploaded custom logo can flow through
`['signed-logos', orgId, sortedCustomPaths]`; built-in URL logos bypass signing.

| # | Consumer and surface | Props passed | Effective shape | Size/radius affected | Plug fallback affected | Signed path affected |
|---:|---|---|---|---|---|---|
| 1 | `agents/manage-tabs/connect-connector-modal.tsx:292` — OAuth connection dialog header | `logo`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected while logo is absent/signing | Yes, direct `useResolvedLogoUrl` |
| 2 | `agents/manage-tabs/connector-table-row.tsx:109` — Manage Connectors table row | `logoUrl`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected | Yes, resolved by `ConnectorsTab` |
| 3 | `agents/manage-tabs/preview-connector-modal.tsx:397` — Preview header | `resolvedLogo`, `displayName`, `size="lg"` | 80px, `lg` radius | Affected | Affected while logo is absent/signing | Yes, direct `useResolvedLogoUrl` |
| 4 | `aistudio/playbooks/components/governance/filters/playbook-governance-filters.tsx:126` — multi-select option/tag | `size="2xs"`, `rounded="full"`, `logo`, `displayName`, `className="size-5 shrink-0"` | outer 20px circle; 12px content | Affected: outer size override survives, inner size and radius do not | Affected | No signed-logo hook in path |
| 5 | `aistudio/playbooks/components/governance/playbook-governance-cells.tsx:393` — governance connectors popover row | `size="2xs"`, `rounded="full"`, `logo`, `displayName` | 24px circle | Affected | Affected | No signed-logo hook in path |
| 6 | `aistudio/playbooks/components/governance/playbook-transfer-ownership-triggers-section.tsx:132` — transfer-ownership trigger tile | `logo`, `logoIcon={Zap}`, `displayName`, `size="2xs"`, `rounded="lg"`, `className="border-0"` | 24px rounded square inside 32px tile | Affected | Unaffected: `Zap` replaces `Plug` | No signed-logo hook in path |
| 7 | `common/event-triggers-selector.tsx:427` — event-trigger selector row | `resolvedLogo`, `displayName`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Affected | Yes, batch `useSignedLogoPaths` |
| 8 | `connectors/connector-card.tsx:46` — small connector-library card | `logo`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected | Yes, `ConnectorLibrary` resolves the supplied `logoUrl` |
| 9 | `connectors/connector-card.tsx:129` — medium connector-library card | `logo`, `displayName`, `size="lg"` | 80px, `lg` radius | Affected | Affected | Yes, same resolved `logoUrl` path |
| 10 | `harness-v2/features/side-panel/tool-call-result-panel/components/playbook-card.tsx:89` — overlapping connector marks | `key`, `logo`, `displayName`, `title`, `size="2xs"`, `rounded="lg"`, ring/overlap `className` | 24px rounded square | Affected; overlap math assumes 24px | Affected | Yes for live org profiles; snapshot/share fallback bypasses signing |
| 11 | `notifications-sidebar/notification-avatar.tsx:180` — connector-added notification avatar | `logoUrl`, `connectorName`, `size="xs"` | 40px, `lg` radius | Affected | Affected | No; notification supplies a renderable URL/value |
| 12 | `playbooks/playbook-list.tsx:177` — primary routine badge | resolved `logo`, `displayName`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Affected | Yes, batch `useSignedLogoPaths` |
| 13 | `playbooks/playbook-list.tsx:252` — additional-routines popover row | resolved `logo`, `displayName`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Affected | Yes, same batch map |
| 14 | `playbooks/playbook-v3/steps-flow/trigger-card.tsx:88` — event trigger tile | `logo`, `logoIcon={Zap}`, `displayName`, `size="2xs"`, `rounded="lg"`, `className="border-0"` | 24px rounded square inside 32px tile | Affected | Unaffected: `Zap` replaces `Plug` | No signed-logo hook in path |
| 15 | `projects/project-settings-connectors/project-settings-connectors.tsx:375` — added connector card | `logo`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected | Yes, parent batch map |
| 16 | `projects/project-settings-connectors/project-settings-connectors.tsx:440` — available connector/profile card | `logo`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected | Yes, parent batch map |
| 17 | `projects/project-settings-connectors/project-settings-connectors.tsx:611` — configure-tools dialog header | `connectorLogo`, `displayName`, `size="xs"` | 40px, `lg` radius | Affected | Affected while logo is absent/signing | Yes, direct `useResolvedLogoUrl` |
| 18 | `routines/event-based/steps/configure-trigger-step.tsx:40` — selected trigger chip | `logo`, `size="2xs"`, `rounded="full"`; component rendered only when `logo` is truthy | 24px circle | Affected | Unaffected: no component is rendered without a logo | Yes, parent resolves through `useResolvedLogoUrl` |
| 19 | `routines/event-based/steps/select-connector-step.tsx:171` — placeholder connector option | `logoIcon`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Unaffected: placeholder glyph replaces `Plug` | No logo or signed path |
| 20 | `routines/event-based/steps/select-connector-step.tsx:208` — connected connector option | resolved `logo`, `displayName`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Affected | Yes, batch `useSignedLogoPaths` |
| 21 | `routines/event-based/trigger-filters-popover.tsx:48` — hover-card connector identity | `logo`, `size="2xs"`, `rounded="full"` | 24px circle | Affected | Affected | No signed-logo hook in this path |

Totals:

- `2xs/full`: 9 usages, including one outer-size override and one conditional render.
- `2xs/lg`: 3 usages.
- `xs/lg` (default radius): 7 usages.
- `lg/lg` (default radius): 2 usages.
- A shared size-or-radius mapping change affects all 21 usages. Three avoid the default `Plug` fallback because they
  supply a glyph or do not render without a logo.
- The signed-logo query path can affect 14 usages. It matters only for custom paths recognized by
  `isCustomLogoPath` (`logo_...`); built-in connector URLs remain direct.

## Change-impact contract

### Size

Do not change the meaning of an existing size token in place. Layouts encode the current pixel sizes: overlapping
Harness marks assume 24px; governance selected tags explicitly corrected 24px to 20px; trigger tiles nest 24px icons in
32px frames; cards and dialog headers reserve space for 40px or 80px tiles. A redesign needing new dimensions must add
a new size or make the opt-in visual variant select a documented size without changing existing tokens.

### Radius and clipping

Do not globally change `rounded="lg"` or its default. The square treatment is used by Manage Connectors, dialogs,
notifications, Harness stacks, and trigger tiles, while `full` is a deliberate compact-list treatment. Because the
tile owns `overflow-hidden`, radius also controls image clipping, not just decoration.

### Fallback and accessibility

Preserve the priority `logo -> logoIcon -> Plug` for the default variant. Any redesigned fallback must account for:

- signing/loading temporarily producing no logo;
- anonymous/share viewers that cannot sign custom paths;
- callers that deliberately supply `Zap` or another connector glyph;
- the selected-trigger chip, which deliberately renders nothing without a logo;
- image alternative text and the current generic `Connector` fallback when no display name is supplied.

The tech spec should decide whether the visual fallback is decorative or meaningful and define accessible naming
accordingly. A `title` tooltip is not a substitute for an accessible name.

### Signed custom logos

Keep signing and path classification outside `ConnectorIcon`. The component accepts a renderable URL; it must not gain
organization/session/query dependencies. The signing contract remains:

```text
raw connector logo path
  -> isCustomLogoPath (`logo_...`)
  -> ['signed-logos', orgId, sortedCustomPaths]
  -> resolveConnectorLogo / useResolvedLogoUrl
  -> renderable URL or undefined
  -> ConnectorIcon logo or fallback
```

Changing the query key, custom-path predicate, sorting/deduplication, or unsigned-path fallback can alter 14 usages at
once. The Manage Connectors table currently uses a weaker expression than the shared resolver:
`logoUrlMap[path] ?? rawPath`; for an unsigned custom path this can send a non-renderable storage path to `<img>`, while
`resolveConnectorLogo` correctly returns `undefined`. A redesign must not encode around that inconsistency. Normalize
the caller to the existing resolver in a separately reviewable behavior fix or explicitly carry it as a prerequisite
in the tech spec.

### WDS boundary and adjacent shared owners

`ConnectorIcon` is an app-level product composition, not a WDS primitive. Its contract may be extended locally, but no
WDS primitive or `fe.wds` package should be edited for this logo redesign.

`ConnectorStatusIndicator` and `DefaultBadge` are adjacent visuals, not part of the icon variant:

- `ConnectorStatusIndicator` is consumed by connector cards, the Manage Connectors row status, and Preview. Keep its
  status semantics and overlay/inline contract independent from logo shape.
- `DefaultBadge` is consumed by the table row and Preview and wraps the legacy app-local `ui/badge`. Do not fold badge
  migration into the icon redesign. If the approved design requires a missing WDS badge treatment, raise it upstream
  in `fe.wds` rather than adding another local primitive wrapper.

## Tech-spec acceptance criteria

Before implementation is approved, the tech spec should require:

1. The default `ConnectorIcon` variant renders exactly as today for all 21 existing usages.
2. Only explicitly opted-in Manage Connectors usages receive the redesigned treatment.
3. The approved variant defines tile size, content size/fit, radius, border/background, fallback priority, dark mode,
   and accessible naming as one contract.
4. Built-in URLs, signed custom URLs, signing-in-flight, signing failure/no org scope, `logoIcon`, and no-logo fallback
   states are all represented in focused coverage or Storybook states.
5. The 20px governance override, 24px Harness overlap stack, 32px trigger-tile nesting, and 40/80px card/dialog layouts
   remain unchanged unless they explicitly opt in.
6. The signed-logo query key and resolver remain outside `ConnectorIcon`; any normalization of the Manage Connectors
   table's raw-path fallback is reviewed separately from visual styling.
7. `ConnectorStatusIndicator` and `DefaultBadge` changes are scoped and reviewed independently; no WDS primitive is
   edited in this repository.

## Risks and verification limits

- This is a static source contract, not runtime or visual verification. Feature flags and remote connector payloads
  were not exercised.
- Several consumers pass raw connector logos without the signed-logo resolver. That is safe for built-in URL logos but
  may not support org-uploaded custom logos; the matrix records current data flow, not a claim that every path is
  correct.
- `className` can override the tile but not the image/glyph class. A future variant relying on consumer overrides will
  be fragile; variant-owned styling should remain centralized.
- The separate connector-UI registry component has the same exported name. Tech-spec and implementation work must use
  full paths when discussing either component to avoid accidental scope expansion.

Source: fresh static, read-only trace of `frontend/src` on 2026-08-19. Unverified against runtime.
