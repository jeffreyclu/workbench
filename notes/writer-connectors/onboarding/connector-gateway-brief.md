# Connector Gateway — onboarding brief

**For:** Jeffrey Lu, joining the Connectors team
**Compiled:** 2026-08-20 · **Sources:** Confluence, Jira, Linear, and the `writer-monorepo` checkout
**Slack and Google Drive were not searched** — see "Coverage and gaps" at the bottom. That is a real hole in this brief, not a formality.

---

## The 60-second version

The feature you keep hearing called "Connectors Gateway" is actually **Connector Gateway** — singular, usually abbreviated **CG**. It is not a new product surface. It's a **new API surface inside the existing `be.mcp-gateway` service** (`src/connector-gateway/`), exposed at `/api/connector-gateway/v1/...`, that replaces the older `/api/mcp-gateway/v2` and `/v3` endpoints for connector catalog, profiles, tools, and OAuth.

It is **live in production but gated**, not GA. A Statsig gate named `connector-gateway` decides, per organization, whether a given org talks to CG or the legacy MCP Gateway endpoints. Writer's own prod org `3002` is on it. The frontend carries both code paths and forks on that flag in at least seven places.

The team is the **Connectors / MCP squad** — Ashley Brooks (PM), Dennis Thompson (eng lead), David Chen, Colin McNeil, Vinh Vu, Kapil Duraphe, Rabe Alsilwadi (QA). Their tracker is **Linear** (`CON-*`), though a lot of adjacent work sits in **Jira** (`WE-*`, `ACTION-*`).

---

## 1. The name

**Verified.** The canonical name is **Connector Gateway**, abbreviated **CG** in team shorthand.

| You'll see | What it means |
|---|---|
| `Connector Gateway` | The canonical name. Used in the RFC title, Linear project name, and commit subjects. |
| `CG` | Team abbreviation. Ubiquitous in Linear issue titles (`CON-13 "…not working for CG"`, `CON-4 "CG: per-user tool enablement…"`). |
| `connector-gateway` | The Statsig gate name, the URL path segment, and the Linear label. |
| `Connectors Gateway` (plural) | **Not used anywhere in the sources.** This is the rough wording only. |
| `MCP Gateway` / `mcp-gateway` | The *service* CG lives inside, and the *legacy* API surface CG replaces. Overloaded — see the naming trap below. |

**The naming trap.** [WE-19181](https://writerai.atlassian.net/browse/WE-19181) opens with "the **MCP Gateway** — also known as the **Connector Gateway**". That is loose. Reading the code and the rest of the tickets, the precise picture is:

- `be.mcp-gateway` is **one service** that hosts **two API surfaces**: the legacy `/api/mcp-gateway/v2|v3` and the newer `/api/connector-gateway/v1`.
- "MCP Gateway" is the service and the old surface. "Connector Gateway" is the new surface.
- Treat anyone using them interchangeably as speaking loosely. When it matters, ask which URL prefix they mean.

**Also do not confuse CG with "Connector UI."** [Connector UI](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4813946883/Connector+UI+Overview) is an unrelated, separately-named feature: the in-chat display layer in Writer Agent that renders connector activity as cards. Same word, different thing, different doc, different audience.

---

## 2. What it is and why it exists

**Verified.** CG is the tool-execution and connector-configuration substrate underneath Writer Agent. Per [WE-19181](https://writerai.atlassian.net/browse/WE-19181), the gateway is what "AI models call to discover and execute tools across Writer's third-party integrations," with **117 connector definitions** in the repo as of 2026-08-11 and **semantic tool discovery** via pgvector embeddings over connector and tool descriptions.

**Why it was built** — from the [RFC: Connector Gateway Profiles](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4781211681/RFC+Connector+Gateway+Profiles) (David Chen, last modified 2026-06-15):

> "Over the last few months, the Connectors team has added the following features: Custom Connector, Private Endpoint, Dynamic Tools, Client Credentials as First Class Auth type, Multiple Profiles (aka v3 Profiles). With introduction Connector Gateway, we are given an opportunity to better address pain points that users are having with creating a profile."

**Read that carefully.** The stated motivation is that five features were bolted onto the old surface one at a time, and profile creation had become painful. CG is the consolidation. That framing is the single most useful thing to carry into your own work on the connectors page.

*Inference (mine, not stated in a source):* because the driver was profile-creation UX rather than a runtime or scaling problem, the migration's risk is concentrated in **contract fidelity** — whether the new endpoints return everything the old ones did. The bug pattern in §7 is consistent with that, but no source states this causal claim.

---

## 3. Ownership

**Verified** from Linear project leads, Jira reporters/assignees, and the Confluence on-call page.

| Person | Role | Evidence |
|---|---|---|
| **Ashley Brooks** | PM. Priority calls; escalation target. | [On-call roles](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4713480219/On-call+roles+and+responsibilities): "align with Ashley on priority and sequencing" |
| **Dennis Thompson** | Eng lead. Reported WE-16471, leads the *QA Connector Gateway* Linear project. | [WE-16471](https://writerai.atlassian.net/browse/WE-16471); Linear project lead |
| **David Chen** | Full-stack, FE-leaning. Wrote the CG Profiles RFC; leads *MCP Control Panel Analytics*. | RFC author |
| **Colin McNeil** | Backend. Landed the main `Connector Gateway [WE-16471] (#12083)` commit. | `git log`, 2026-08-03 |
| **Vinh Vu** | Backend. Led *MCP OAuth stability* (completed 2026-08-03). | Linear |
| **Kapil Duraphe** | Backend. Leads *Q2 New Connectors*. Your onboarding buddy. | Linear |
| **Rabe Alsilwadi** | QA. Assignee on most CG QA tickets. | Linear, [WE-16471](https://writerai.atlassian.net/browse/WE-16471) |
| **Carrie Curtin** | Leads the Linear *MCP* project ("ongoing connector upgrades"). | Linear |

**Adjacent, not on the team:** Michael Donahue and Sharath Sheripally do CG-touching work from the **Writer Agent** side (`ACTION-*`). When a CG bug is really a Writer Agent integration bug, it lands there instead. Worth knowing which tracker a ticket is in before assuming who owns it.

**Where the team lives:**
- Confluence home: [Connectors/MCP Squad](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4515987570/Connectors+MCP+Squad) (space `ENG`) — parent of *Enterprise MCP → RFCs*, *Engineering Docs* (onboarding, runbooks, incidents, on-call, features), and the retros.
- Linear team: [Connectors](https://linear.app/writer/team/CON) — `CON-*`.
- Slack channels (names verified from the on-call page and a Linear project summary; **contents not read**): `#feedback-product-connectors` (primary inbound), `#feedback-product-writer-agent`, `#team-mcp` (internal), `#product-connector-feedback`.

---

## 4. Architecture

**Verified** against `~/dev/writer-monorepo` and the generated SDK.

```
Writer Agent frontend (writer-monorepo)
        |
        |  useFeatureFlag('connector-gateway')  <-- Statsig gate, per org
        |
   +----+----------------------------+
   | flag ON                         | flag OFF
   v                                 v
/api/connector-gateway/v1/...    /api/mcp-gateway/v2|v3/...
   \                                 /
    \                               /
     +------> be.mcp-gateway <-----+
              (one service, two surfaces)
```

**CG v1 endpoints the frontend uses** — read from `frontend/src/generated/mcp-gateway/sdk.gen.ts`. Note that they are generated into the **`mcp-gateway`** SDK module, which is itself evidence of the one-service-two-surfaces shape:

- `GET /api/connector-gateway/v1/organization/{orgId}/connectors/` — connector catalog
- `GET /api/connector-gateway/v1/organization/{orgId}/tools/list/{connector}` — tool list
- `GET|POST /api/connector-gateway/v1/organization/{orgId}/profiles` — org profiles
- `GET /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/my` — the caller's profiles
- `POST .../profiles/{profileId}/connect` and `/disconnect`
- `/api/connector-gateway/oauth/callback`

**The flag forks in the frontend** (`useFeatureFlag('connector-gateway')`), seven live call sites:

| File | Surface |
|---|---|
| `frontend/src/components/agents/manage-tabs/connectors-tab.tsx:131` | **The connectors page — your area** |
| `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts:114` | Shared gateway data layer |
| `frontend/src/hooks/use-user-connectors.ts:16` | User connector list |
| `frontend/src/hooks/use-connector-auth.ts:49` | Connector auth |
| `frontend/src/components/common/event-triggers-selector.tsx:86` | Event-based triggers |
| `frontend/src/components/playbooks/playbook-v3/editor.tsx:357` | Playbook v3 editor |
| `frontend/src/components/thread/chat-input/use-chat-input-data.ts:38` | Chat input |

**Client default is OFF** — `frontend/src/constants/launchdarkly-flags.ts:151` sets `'connector-gateway': false`.

**Backend side**, from [WE-19181](https://writerai.atlassian.net/browse/WE-19181): `src/connector-gateway/` in `be.mcp-gateway` contains orchestration, tool-discovery, oauth2, profile, execution, credentials, and migration modules. Orchestration is described as the largest module.

**Downstream consumers you should know about.** CG's public API already has an in-cluster consumer outside the team: `be.service.observability` reads connector *structure* from it for the AI Studio Connectors Analytics and Govern tabs, requiring `Organization.McpConnector.View` with forwarded caller credentials ([RFC + Handover — WE-18315](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4866474002/RFC+Handover+WE-18315+Connectors+Observability), [2026-08-04 Connector Analytics & Governance Surface](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4866244621/2026-08-04+Connector+Analytics+Governance+Surface), status *Accepted*). Changing a CG response shape is not a connectors-team-only decision.

---

## 5. Release and rollout — the actual timeline

**Verified** from `git log` in `writer-monorepo` plus ticket dates. This is the strongest evidence available, because it's the shipped record rather than a plan.

| Date | Event |
|---|---|
| 2026-07-06 | [WE-16471 "CG in WA"](https://writerai.atlassian.net/browse/WE-16471) opened by Dennis Thompson — "Set up connector gateway endpoints in WA" |
| 2026-07-08 | `feat: wire connector-gateway into apps and profiles` (Dennis Thompson) |
| **2026-07-14** | **`feat: setup connector-gateway [WE-16471] (#10266)`** — the `connector-gateway` flag first appears in the frontend flag registry |
| 2026-07-23 | `feat: use connector-gateway mcp endpoint [WE-16471] (#10545)` (Colin McNeil) |
| **2026-08-03** | **`Connector Gateway [WE-16471] (#12083)`** (Colin McNeil) — the main landing commit |
| 2026-08-07 | `chore: refactor user cg ui for user profiles [WE-16471] (#12868)` |
| 2026-08-11–15 | CG OAuth fixes from the Writer Agent side ([ACTION-7995](https://writerai.atlassian.net/browse/ACTION-7995)) |
| 2026-08-19 | First prod-org bug filed against CG orgs ([ACTION-8107](https://writerai.atlassian.net/browse/ACTION-8107)) |

WE-16471 was closed **Done** on 2026-07-27.

**Current release state — verified:**
- **Gated, per-organization, in production.** [CON-163](https://linear.app/writer/issue/CON-163) documents the Statsig gate `connector-gateway`: `idType=userOrgID`, `targetApps` includes `mcp-gateway`, production rules match on custom field `organizationId`. Gate console: `https://console.statsig.com/2WLGwQ9ootwTimNteZTZOQ/gates/connector-gateway`.
- **Writer's own prod org `3002` is enabled** ([ACTION-8107](https://writerai.atlassian.net/browse/ACTION-8107), reproduced live 2026-08-19).
- **QA is still open.** The Linear project [QA Connector Gateway](https://linear.app/writer/project/qa-connector-gateway-4fc0a802782f) is *In Progress*, started 2026-08-03, lead Dennis Thompson, with open items still in Blocked and QA Review.

**No source I found announces a GA date, a customer-facing launch, or release notes.** I searched for them. If a launch announcement exists, it is almost certainly in Slack — which I could not read.

---

## 6. Key decisions worth knowing

**Verified.**

1. **CG ships behind a per-org Statsig gate, not a big-bang cutover.** Both code paths live in the frontend simultaneously. Consequence: every connectors-page change must work on both branches until the legacy path is deleted, and any bug report needs "is this org on CG?" as the first triage question.
2. **CG is an additive surface inside `be.mcp-gateway`, not a new service.** No new deployment, no new repo. It rides the existing `charts/connectors` bundle.
3. **Profile creation is being redesigned around a multi-step form** — Details → Type → Connection → Tools ([RFC: Connector Gateway Profiles](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4781211681/RFC+Connector+Gateway+Profiles)). Profiles carry `level` (`USER`/`ORG`), `type` (`SELF`/`WRITER`-managed), `teamIds`, auth config, `allowedTools`, and a mutually-exclusive `privateEndpointId` **or** `tenantUrl`.
4. **Auth-type vocabulary is deliberately lossy in the UI.** Three distinct backend auth domains — `code_grant`, `dcr`, `private_key_jwt` — all display as "OAuth2". `client_credentials` displays as "Service Account". The RFC calls the shared label "intended." Expect UI-vs-backend terminology mismatches and don't "fix" them without asking.

**Caveat on that RFC:** its status field still reads **`draft`** and it was last modified 2026-06-15 — *before* the main implementation landed on 2026-08-03. Treat it as design intent, not as a description of shipped behavior.

---

## 7. Known limitations and active follow-up work

**Verified, all currently open or recently closed.**

**The bug pattern to internalize** — [ACTION-8107](https://writerai.atlassian.net/browse/ACTION-8107) (Approved for Prod, filed 2026-08-19). On CG orgs, "Save to Google Drive" silently vanished from the Export menu even with Drive connected. Root cause: the frontend passed the connector **enum** (`GOOGLE_DRIVE`) into CG's free-text `query` param, but CG matches on **display name** ("Google Drive"). Measured against org 3002: `GOOGLE_DRIVE` → 0 results, `Google Drive` → 1. Zero rows meant the status resolved to `not_available` and every affected menu entry was hidden — while the Connectors tab still showed "Connected", because it fetches the list unfiltered.

That is the archetype: **legacy call shapes replayed against CG semantics, failing silently rather than erroring.** The same `query: connectorName` pattern still exists in `frontend/src/components/routines/event-based/api.ts`. The proposed fix also surfaces a second limit — dropping the filter makes the request unfiltered, and **the profile list pages at 100** while org 3002 already has 48 org profiles, so larger orgs would truncate without `drainPages`.

**Open / blocked, from Linear:**

| Issue | State | Note |
|---|---|---|
| [CON-14](https://linear.app/writer/issue/CON-14) Reconnect Private Endpoints | **Blocked** | |
| [CON-34](https://linear.app/writer/issue/CON-34) Writer-managed OAuth 404s for **all** Microsoft connectors | **Blocked** | Broad blast radius |
| [CON-37](https://linear.app/writer/issue/CON-37) Profile `orgWideAuth` passed in wrong place | **Blocked** | |
| [CON-170](https://linear.app/writer/issue/CON-170) Private endpoints: resolution gap + SSRF blocks private-link connectors | In Progress | Security-adjacent |
| [CON-152](https://linear.app/writer/issue/CON-152) Connector list fails to load for team members | QA Review | Directly your surface |
| [CON-150](https://linear.app/writer/issue/CON-150) CG public connectors miss env + canary union semantics | QA Review | |
| [CON-42](https://linear.app/writer/issue/CON-42) Profile setup incorrectly offers Writer-managed OAuth | QA Review | |
| [CON-31](https://linear.app/writer/issue/CON-31) "A lot of issues with the configuration modal" | QA Review | |
| [CON-17](https://linear.app/writer/issue/CON-17) New endpoints to edit an existing connector | In Progress | David Chen |
| [ACTION-7995](https://writerai.atlassian.net/browse/ACTION-7995) Restore Agent Connector OAuth with Connector Gateway | In Progress | |

**Testing and observability gaps — verified:**
- **No eval coverage for tool discovery.** [WE-19181](https://writerai.atlassian.net/browse/WE-19181) (epic, To Do, unassigned) records that the in-repo `evals/` harness is **dormant: 13 files, zero test files**, no `evals` npm script, no CI workflow. Since discovery is semantic, "a connector rename, a re-embedding, a description edit, or simply adding the 118th connector can silently degrade discovery for every agent downstream, and nothing measures that today."
- **Contract testing is being built now.** [WE-19229](https://writerai.atlassian.net/browse/WE-19229) / [CE-414](https://linear.app/writer/issue/CE-414) — publish a SmokeStack CG contract bundle so Writer Agent can test against a faithful mock without Dev network access. Fixtures already exist at `frontend/tests/fixtures/connector-gateway/google-sheets-read-v1/`.
- **Prometheus metrics are only landing now** — [ACTION-8117](https://writerai.atlassian.net/browse/ACTION-8117) (P0) and [ACTION-8118](https://writerai.atlassian.net/browse/ACTION-8118) (P1), both In Progress as of 2026-08-19.

**Also in flight:** [ACTION-8120](https://writerai.atlassian.net/browse/ACTION-8120) "lift out connector ui", and the Linear [Connectors UI Revamp](https://linear.app/writer/project/connectors-ui-revamp-f1d4106eac2b) project (Backlog) — the neighbourhood of your CON-159 work.

---

## 8. Conflicts and stale information

Flagging these so you don't get burned repeating them.

1. **"LaunchDarkly flag" is wrong — it's Statsig.** [ACTION-8107](https://writerai.atlassian.net/browse/ACTION-8107) says org 3002 is on "the `connector-gateway` **LaunchDarkly** flag." [CON-163](https://linear.app/writer/issue/CON-163) shows the actual gate is in the **Statsig** console. The monorepo's `docs/features/feature-flags.md` confirms Statsig is now the default provider for both frontend and backend. The confusion is understandable: the frontend flag registry is still in a file literally named **`frontend/src/constants/launchdarkly-flags.ts`**, which is now a misnomer. **Say Statsig.**
2. **"MCP Gateway = Connector Gateway."** [WE-19181](https://writerai.atlassian.net/browse/WE-19181) asserts this. It's a useful shorthand and a bad precision. See §1.
3. **The Profiles RFC is stale.** Status `draft`, last touched 2026-06-15, ~7 weeks before the implementation landed. It carries an explicit `NEED VERIFICATION` marker on the "Create a Private Endpoint" flow and two unresolved open questions of its own.
4. **Two "connectors" frontends.** `writer-monorepo` (Writer Agent, where CG work happens) and `fe.web-app` (AI Studio, legacy). Same team owns both. A "connectors bug" can mean either.

---

## 9. Open questions I could not answer

Not gaps in effort — gaps in the sources. Each of these was searched for and not found.

1. **Is there a launch announcement or GA plan?** Nothing in Confluence, Jira, or Linear announces CG's release, names a GA date, or defines rollout stages beyond "Statsig gate per org." Most likely lives in Slack.
2. **Which orgs are on the gate right now, and what's the ramp?** Only org `3002` is confirmed. The gate's targeting rules are in the Statsig console, which I could not read.
3. **When do the legacy `/api/mcp-gateway/v2|v3` endpoints get deleted?** No deprecation ticket, timeline, or decision found. This directly affects how long the connectors page must carry both branches — worth asking Dennis.
4. **Who owns CG eval dataset curation?** [WE-19181](https://writerai.atlassian.net/browse/WE-19181) asks this itself ("the gateway team, or AI Evaluation?") and it is unassigned, To Do.
5. **Was there a formal architecture RFC for CG itself?** I found only the *Profiles* RFC, which treats CG as already-decided context. Either the founding design doc lives somewhere I can't see, or the decision was made in Slack.

---

## 10. Coverage and gaps — read this before trusting the brief

**Searched and read:**
- **Confluence** — Rovo search plus CQL title and full-text sweeps. Walked the entire [Connectors/MCP Squad](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4515987570/Connectors+MCP+Squad) page tree (68 descendants). Exactly **one** page has "Connector Gateway" in its title.
- **Jira** — JQL across `WE`, `ACTION`, `WS`. Read WE-19181, WE-16471, ACTION-8107 in full.
- **Linear** — the `Connectors` team, all 12 projects, ~95 issues, and CON-163 in full. *(Not requested, but it is where this team actually tracks work, so omitting it would have produced a wrong brief.)*
- **`~/dev/writer-monorepo`** — flag registry, all seven flag call sites, the generated CG SDK, and `git log`.

**Not searched — no integration available in this environment:**
- **Slack.** No Slack MCP server is configured, and `~/dev/workbench/.env` has no `SLACK_BOT_TOKEN`. I could not read a single message. Channel *names* above come from Confluence and Linear; permalinks below come from Jira ticket citations. **Given that several open questions in §9 point at Slack, this is the biggest weakness in the brief.**
- **Google Drive.** No Drive/Docs MCP server configured.
- **Figma.** The Figma MCP server is present but unauthorized (needs OAuth in an interactive session).

To close these: connect a Slack MCP server, or set `SLACK_BOT_TOKEN` in `~/dev/workbench/.env` — the Workbench Slack integration already supports expanding Slack permalinks. Then re-run this against `#feedback-product-connectors` and `#team-mcp`.

---

## Source index

**Confluence**
- [RFC: Connector Gateway Profiles](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4781211681/RFC+Connector+Gateway+Profiles) — David Chen, `draft`, mod. 2026-06-15
- [Connectors/MCP Squad](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4515987570/Connectors+MCP+Squad) — team home
- [On-call roles and responsibilities](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4713480219/On-call+roles+and+responsibilities) — Dennis Thompson, 2026-04-28
- [Connector UI Overview](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4813946883/Connector+UI+Overview) — Garrett Prince, 2026-07-01 (the *other* feature)
- [RFC + Handover — WE-18315 Connectors Observability](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4866474002/RFC+Handover+WE-18315+Connectors+Observability)
- [2026-08-04 Connector Analytics & Governance Surface](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4866244621/2026-08-04+Connector+Analytics+Governance+Surface) — Accepted
- [MCP Team Retro 2026-04-24](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4708106292/MCP+Team+Retro+2026-04-24)
- [Common Custom Connector Errors](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4636704817/Common+Custom+Connector+Errors)

**Jira**
- [WE-16471](https://writerai.atlassian.net/browse/WE-16471) "CG in WA" — the umbrella, Done 2026-07-27
- [WE-19181](https://writerai.atlassian.net/browse/WE-19181) CG Evaluation Suite Q3 2026 — best single description of the service
- [WE-19229](https://writerai.atlassian.net/browse/WE-19229) SmokeStack CG contract bundle
- [ACTION-8107](https://writerai.atlassian.net/browse/ACTION-8107) Save to Google Drive missing on CG orgs
- [ACTION-7995](https://writerai.atlassian.net/browse/ACTION-7995) · [ACTION-8117](https://writerai.atlassian.net/browse/ACTION-8117) · [ACTION-8118](https://writerai.atlassian.net/browse/ACTION-8118) · [ACTION-8120](https://writerai.atlassian.net/browse/ACTION-8120)

**Linear**
- [QA Connector Gateway](https://linear.app/writer/project/qa-connector-gateway-4fc0a802782f) · [Connectors UI Revamp](https://linear.app/writer/project/connectors-ui-revamp-f1d4106eac2b) · [MCP](https://linear.app/writer/project/mcp-2776e5ceae76)
- [CON-163](https://linear.app/writer/issue/CON-163) — the Statsig gate facts

**Slack permalinks cited by tickets (not read by me)**
- `#feedback-product-connectors`-adjacent report behind ACTION-8107: https://writerai.slack.com/archives/C095K66CKRN/p1787130818897249
- https://writerai.slack.com/archives/C0BB6TDV5RV/p1787075103291979
- https://grid-writerai.enterprise.slack.com/archives/C0AL7UTLHRC/p1781202577931649
- https://grid-writerai.enterprise.slack.com/archives/C06EP2UKCHK/p1778465310316719

**Code** (`~/dev/writer-monorepo`)
- `frontend/src/constants/launchdarkly-flags.ts:151` · `frontend/src/hooks/use-feature-flags.ts` · `frontend/src/generated/mcp-gateway/sdk.gen.ts` · `frontend/src/components/agents/manage-tabs/connectors-tab.tsx:131` · `docs/features/feature-flags.md`
