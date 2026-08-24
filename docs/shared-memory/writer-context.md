## Writer context

### No pluto in writer context **(always)**

*Never reference PLUTO in anything related to Writer work*

Jeffrey has drawn a hard boundary: PLUTO must never be referenced when discussing, summarizing, or working on anything related to Writer. He stated explicitly that PLUTO is not part of his job at Writer at all.

This applies to every Writer-related output — task summaries, weekly recaps, tech specs, code review notes, onboarding notes, and any other Workbench artifact touching Writer or the connectors team's work. Do not mention PLUTO, draw comparisons to it, or pull it in as context, even if it seems relevant or shows up in retrieved history. If PLUTO-related material surfaces in a search or shared brief while doing Writer work, omit it rather than summarizing or referencing it.

### Jeffrey is on connectors team

*Jeffrey is a member of the connectors team himself, not an external party to consult*

Jeffrey is on the connectors team — he is not an outside stakeholder who needs to be looped in
separately from it. When writing tech specs, checklists, or action items that involve the
connectors team, do not phrase items as "confirm with the connectors team" or "check with the
connectors team" as if Jeffrey were external to it. Write the action as something Jeffrey (or
whoever owns the doc) does directly, e.g. "Verify no PII ends up in client-side logs" rather than
"Confirm with the connectors team that no PII ends up in client-side logs."

This came up sharply in review of the `manage-connectors-v2.html` tech spec's security section,
where a security-check item told Jeffrey to go confirm something with "the connectors team" —
he pointed out he *is* the connectors team.

### Mcp backend design documented

*MCP backend architecture documented in shared knowledge*

The WRITER MCP backend design (from Dennis Thompson's Confluence doc, Jan 6 2026) has been summarized and stored in `/Users/jeffrey.lu/notes/knowledge/writer-mcp-backend-design.md` as shared, durable context.

Key points:
- `be.mcp-gateway` is a fork of open-source ACI, wrapped as a new service
- Five core tables: `apps`, `functions`, `app_configurations`, `linked_accounts`, `org_dek`/`managed_oauth_credentials`
- Hard rule: org must configure a connector before any user can use it (org-before-user)
- Token flow: access tokens in Redis, refresh tokens encrypted in DB
- This is foundational context for Connector Gateway (CG), which is built on top of this

The doc itself doesn't address CG specifics (like why `enabled` is missing from CG responses — it exists in the DB but CG hasn't mapped it yet).

### Jeffrey ai plan tiers

*Jeffrey's Claude and Codex subscription tiers, which set the ceiling for any usage-budget math*

Jeffrey told me on 2026-08-22 to remember his subscription tiers, because any budget or capacity
estimate depends on them. He is on the **$100/month tier for both Claude and Codex**, and he plans to
**raise Codex to $200/month the following month** (September 2026). Claude stays at $100/month as far
as he has said.

This matters whenever I estimate how much automated or autonomous work can run — for example the
Workbench self-automation work, where he capped autonomous execution at 20% of each provider's weekly
limit. Before that, capacity numbers had to be presented as a bracket because the tier was unknown;
now they collapse to a single figure. Ask him to re-confirm rather than assuming, if a estimate is
being made well after this date, since the Codex upgrade was scheduled rather than done.

The practical design lesson he drove out of this: never hard-code a provider's usage ceiling. Store it
as a value that can be updated, because his plans change on a known schedule and a hard-coded ceiling
would silently spend the wrong amount.

### Career planning meeting prep

*Pre-notes for Staff promotion discussion with manager*

Three days into role (Dennis's email 2026-08-17), planning first career-trajectory conversation with Dennis Thompson.

#### Key frame before booking

Two cycles, not one. Gives Dennis room to land "next cycle is realistic" without cornering him. Doesn't cost you if he volunteers faster.

Confirm Dennis is actually your manager before sending the request (unverified in roster).

#### Meeting setup

- 45 minutes, titled "Growth plan + Staff expectations"
- Send agenda in advance so Dennis has time to think
- Sample language: "Want to spend time on my growth trajectory. Specifically: what Staff looks like at Writer, an honest read on where I am against it, and what to aim at over the next two cycles."

#### Questions to ask (bring prepared)

##### Calibration
- Is there a written ladder for Staff, and can I read it?
- Who was most recently promoted to Staff on this org, and what was the case made for them?
- Who decides — you alone, a committee, cross-org calibration?
- What's the realistic timeline from "clearly performing at Staff" to "title lands"?

##### Scope and impact
- What's the concrete difference between Senior and Staff here — technical depth, cross-team influence, or owning ambiguous problems end to end?
- What does Staff-level impact look like specifically on connectors?
- Where's the gap between what I'm doing now and that bar?

##### Evidence
- What artifacts count? Design docs, incident leadership, mentorship, cross-repo initiatives?
- How is this evaluated — peer feedback, your judgment, something written?

##### The real answer question (ask near the end)
> If the promo committee met today and someone argued for me at Staff, what's the strongest objection they'd raise?

This surfaces the actual gap. Everything before it is context.

#### Evidence to bring from three days of work

**You verify claims instead of inheriting them.** Caught the tech spec asserting that connector-gateway returns `enabled` when it doesn't — the frontend adapter fabricates it. That's a wrong shared mental model corrected before it shaped an implementation.

**You found a live bug during spec work.** The `logoUrlMap[path] ?? rawPath` fallback in `connectors-tab.tsx` sends unsigned storage paths to `<img>`, and the same fallback is duplicated in `ConnectorCard`.

**You closed a blocker by reading source others treated as unreachable.** The org-tool-ceiling question was staged as an escalation to the CG owners; you read the backend through the GitHub API and resolved it instead.

### Jeffrey's local development workflow (writer-monorepo)

Jeffrey works as a **frontend engineer**. His normal local setup runs only the Next.js frontend
(`cd frontend && pnpm dev`) pointed at the **deployed dev backend**, not a local one. In
`frontend/.env` that is the `BACKEND_URL` going through the kubectl API-server proxy, e.g.
`http://localhost:8001/api/v1/namespaces/default/services/skynet-backend:80/proxy/api`, as opposed to
the local alternative `http://localhost:8000/api`.

He stated plainly that "the proxy version is supposed to work" and that he does not need the backend
running locally. When frontend requests fail against that proxied backend, the task is to **make the
proxied path work** — not to switch him onto the local backend. Flipping `BACKEND_URL` to
`localhost:8000` sidesteps his workflow and forces him into running the full backend stack (AlloyDB
proxy, Redis, Restate, worker, FastAPI) that he deliberately avoids. Propose any suggestion requiring
local backend services only as an explicitly-labeled fallback, after exhausting frontend-only fixes.

The local backend is still fine for *diagnosis* — using it as a control to isolate whether a failure is
frontend- or backend-side is fine, as long as the delivered fix restores the proxied configuration.

### Legacy custom connector surface ownership

The organization-level Create Connector workflow at
`/aistudio/organization/:organizationId/connectors` is implemented in the legacy `fe.web-app` repository,
not `writer-monorepo`. Its OpenAPI authentication picker is in
`apps/service.writer-app/src/components/organisms/CustomConnector/components/EditConnectorDetailsForm.tsx`;
the MCP variant is `MCPConfigureStep.tsx` beside it. This was verified from the reported production UI and
local source on 2026-08-24.

### Treat terminology in Jeffrey's meeting notes as phonetic

Jeffrey writes meeting notes by typing what he hears in the moment. He confirmed this on 2026-08-19
about the term "Agent Studio": *"no idea, i just typed what i heard."* The notes are a faithful record
of the sounds in the room, not a vetted glossary.

Any unfamiliar proper noun, enum value, or product name appearing in his notes — especially in
`~/notes/meetings/raw/` — must be verified against the codebase before being repeated in a document,
spec, or knowledge file. Two confirmed instances from one set of notes: a connector tool type recorded
as `map` turned out to be `mcp`, and "Agent Studio" appears nowhere in any Writer codebase or
document, the evidence pointing to it being spoken shorthand for the real "Agent Builder" surface.

When a term cannot be confirmed in code, say so and attribute it to the meeting rather than presenting
it as an established name. Asking Jeffrey to confirm the term is not productive — he is reporting what
he heard, not what he knows.
