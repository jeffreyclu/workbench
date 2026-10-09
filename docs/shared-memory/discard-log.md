tier: workbench

# Discard log

Append-only. Every numbered memory entry removed from a topic file is recorded here in full (date, source file, number, reason, superseding citation) before it is replaced by a tombstone. Written only by `removeKnowledgeEntries` in `src/server/discard-log.ts`; never edit by hand.

### <a id="1"></a>1. engineering-standards.md#22 removed 2026-10-09

- Date: 2026-10-09
- Source file: engineering-standards.md
- Number: 22
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: a4b3562a-4703-48c5-b8bd-ac78ed2e936d

> ## <a id="22"></a>22. Engineering standards

### <a id="2"></a>2. fe-web-app-stack-migration.md#1 removed 2026-10-09

- Date: 2026-10-09
- Source file: fe-web-app-stack-migration.md
- Number: 1
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 8f6690dd-0fe9-47fc-985f-db5ab4eb0d38

> ## <a id="1"></a>1. T2 starting point (2026-09-25)

### <a id="3"></a>3. fe-web-app-stack-migration.md#9 removed 2026-10-09

- Date: 2026-10-09
- Source file: fe-web-app-stack-migration.md
- Number: 9
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 559bf89b-1255-4921-887e-6f4ae206dab7

> ## <a id="9"></a>9. Actionable plan

### <a id="4"></a>4. integration-constraints.md#8 removed 2026-10-09

- Date: 2026-10-09
- Source file: integration-constraints.md
- Number: 8
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 107c851f-d1c5-4040-82e7-136c8b140325

> ## <a id="8"></a>8. Integration constraints

### <a id="5"></a>5. verification-and-debugging-method.md#20 removed 2026-10-09

- Date: 2026-10-09
- Source file: verification-and-debugging-method.md
- Number: 20
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: b006fae6-eb19-4519-ad36-181039cf0299

> ## <a id="20"></a>20. Verification and debugging method

### <a id="6"></a>6. workbench-frontend-lessons.md#62 removed 2026-10-09

- Date: 2026-10-09
- Source file: workbench-frontend-lessons.md
- Number: 62
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 2f3262a7-46a4-4027-88c7-2818fd070869

> ## <a id="62"></a>62. Workbench frontend lessons

### <a id="7"></a>7. workbench-frontend-lessons.md#35 removed 2026-10-09

- Date: 2026-10-09
- Source file: workbench-frontend-lessons.md
- Number: 35
- Reason: Heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 3672dceb-72c0-4bd5-9fb8-b55c972cd205

> ## <a id="35"></a>35. Stale responsive overrides survive UI convention changes — check media queries when a "fixed" style regresses

### <a id="8"></a>8. workbench-operating-practices.md#33 removed 2026-10-09

- Date: 2026-10-09
- Source file: workbench-operating-practices.md
- Number: 33
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 9f071435-d305-4357-abb9-10e646a743e5

> ## <a id="33"></a>33. Workbench operating practices

### <a id="9"></a>9. workbench-product-decisions.md#83 removed 2026-10-09

- Date: 2026-10-09
- Source file: workbench-product-decisions.md
- Number: 83
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: d50e6542-21cd-4166-8a76-8093b86e74ea

> ## <a id="83"></a>83. Workbench product decisions

### <a id="10"></a>10. working-with-jeffrey.md#25 removed 2026-10-09

- Date: 2026-10-09
- Source file: working-with-jeffrey.md
- Number: 25
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 2bc5f549-06fd-4e72-b20b-e1408cdccc6e

> ## <a id="25"></a>25. Working with Jeffrey

### <a id="11"></a>11. writer-context.md#15 removed 2026-10-09

- Date: 2026-10-09
- Source file: writer-context.md
- Number: 15
- Reason: Empty section heading with no body text; nothing to keep.
- Superseded by: none
- Pass: 6b10bd91-0249-4779-b35d-f27b667eb5d7

> ## <a id="15"></a>15. Writer context

### <a id="12"></a>12. short_term_memory:1cc6322a-81b1-4067-b859-a6fee8395fe0 archived 2026-10-09

- Date: 2026-10-09
- Source: short_term_memory:1cc6322a-81b1-4067-b859-a6fee8395fe0
- Reason: One-off eval-gate workflow explanation for a single conversation.
- Proposal: 2da6fd8c-a4a6-4b2a-98f4-f0864146038b
- Removal: none (rebuildable projection)

> ### pluto
> Conversation: 1cc6322a-81b1-4067-b859-a6fee8395fe0
> Project: Pluto
> - agent_handoff from claude:
>   Facts: ## Problem
> You're asking what the `eval-gate` workflow I added last turn actually is.
> 
> ## Solution
> `.github/workflows/eval-gate.yml` — a GitHub Actions job that checks Pluto's retrieval and handoff quality against live APIs. It:
> 
> - Runs **weekly (Mon 09:00 UTC) or on manual dispatch** — deliberately not on PRs, because it costs real Anthropic/OpenAI calls and a provider hiccup shouldn't block a merge.
> - Writes `.env.local` from 5 repo secrets, starts `npm run dev`, then runs `scripts/citation-test.cjs` and fails if citation resolution < 95% or hallucinations > 0.
> - Runs `node scripts/run-bench.cjs --tier handoff` (tier selectable on dispatch) and uses its exit code as the gate.
> - Uploads `.bench-logs/`, `.citation-test-logs/`, `dev-server.log` even on failure.
> 
> ## Context
> It exists because `ci.yml` can't catch a retrieval or handoff regression — every `*.live.test.ts` self-skips there. The file is committed but **has never executed**; it needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the three Supabase secrets in the repo, and it fails fast if any are missing. Delete it if you'd rather run the bench by hand.
>   Blockers: It exists because `ci.yml` can't catch a retrieval or handoff regression — every `*.live.test.ts` self-skips there. The file is committed but **has never executed**; it needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the three Supabase secrets in the repo, and it fails fast if any are missing. Delete it if you'd rather run the bench by hand.
>   Evidence: - Writes `.env.local` from 5 repo secrets, starts `npm run dev`, then runs `scripts/citation-test.cjs` and fails if citation resolution < 95% or hallucinations > 0.
> - Uploads `.bench-logs/`, `.citation-test-logs/`, `dev-server.log` even on failure.
> It exists because `ci.yml` can't catch a retrieval or handoff regression — every `*.live.test.ts` self-skips there. The file is committed but **has never executed**; it needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the three Supabase secrets in the repo, and it fails fast if any are missing. Delete it if you'd rather run the bench by hand.
> - decision from jeffrey:
>   Decisions: i don't want it to run weekly. we cannot run the bench evals that trigger REAL openai or antrhopic calls and spend tokens. that's not acceptable. 
> 
> the non real call tests should be made to run in CI if they aren't already
>   Blockers: i don't want it to run weekly. we cannot run the bench evals that trigger REAL openai or antrhopic calls and spend tokens. that's not acceptable.
>   Evidence: the non real call tests should be made to run in CI if they aren't already
> - agent_handoff from claude:
>   Facts: ## Problem
> CI had a weekly `eval-gate` workflow that burned real Anthropic/OpenAI tokens, and the mocked component suite (97 files) ran nowhere automated.
> 
> ## Solution
> Branch `eval/ci-no-live-calls`, worktree `/Users/jeffrey.lu/dev/Pluto-Alpha-eval-ci`, commit `57a7b2d8`:
> 
> - **Deleted `.github/workflows/eval-gate.yml`.** No cron, no manual dispatch, no CI path that can spend tokens. `scripts/run-bench.cjs` and `scripts/citation-test.cjs` still run locally by hand.
> - **Added a `components` step to `ci.yml`** (`npm run test:components`). `npm run eval` only matches `.test.ts`, so the 97 `.test.tsx` files were never run by any automation.
> - **Fixed 3 rotted files.** vitest 4's jsdom env doesn't expose `localStorage`; `evals/components/setup.ts` now polyfills Web Storage as a Proxy so `Object.keys(localStorage)` enumerates items.
> 
> ## Context
> - Verified in this run: `npx tsc --noEmit && npm run test:components` → exit 0, **97 files / 794 tests passed**. Before the fix: 3 files / 21 tests failed (reproduced in the primary checkout too — pre-existing).
> - `npm run eval` was untouched and already in CI; I did not re-run it.
> - Work is committed locally only. Not pushed — no external-mutation capability this turn.
> - My original assigned worktree was deleted mid-run; I created the one above off `handoff/lossless-part-2`.
>   Blockers: - Verified in this run: `npx tsc --noEmit && npm run test:components` → exit 0, **97 files / 794 tests passed**. Before the fix: 3 files / 21 tests failed (reproduced in the primary checkout too — pre-existing).
>   Evidence: CI had a weekly `eval-gate` workflow that burned real Anthropic/OpenAI tokens, and the mocked component suite (97 files) ran nowhere automated.
> - **Deleted `.github/workflows/eval-gate.yml`.** No cron, no manual dispatch, no CI path that can spend tokens. `scripts/run-bench.cjs` and `scripts/citation-test.cjs` still run locally by hand.
> - **Added a `components` step to `ci.yml`** (`npm run test:components`). `npm run eval` only matches `.test.ts`, so the 97 `.test.tsx` files were never run by any automation.
> - **Fixed 3 rotted files.** vitest 4's jsdom env doesn't expose `localStorage`; `evals/components/setup.ts` now polyfills Web Storage as a Proxy so `Object.keys(localStorage)` enumerates items.
> - Verified in this run: `npx tsc --noEmit && npm run test:components` → exit 0, **97 files / 794 tests passed**. Before the fix: 3 files / 21 tests failed (reproduced in the primary checkout too — pre-existing).
> - decision from jeffrey:
>   Decisions: what is step 2 and 4 and 5
> - agent_handoff from claude:
>   Facts: ## Problem
> Steps 2, 4, 5 from `~/Documents/Workbench/notes/pluto-rag-handoff-readiness-plan.md`.
> 
> ## Solution
> - **2 — Run the handoff tier whole.** `node scripts/run-bench.cjs --tier handoff`, 31 cases, read the exit code.
> - **4 — Close the never-run six.** h17–h22 have no results: web-to-journey, insight decay, insight two-artifacts, web decay, web two-artifacts, all-lanes union. Run via `--ids`.
> - **5 — Widen RAG ground truth.** Labels cover 8 of 69 questions. Fill synthesis (8), citation_discipline (4), domain_knowledge (4), retrieval (3), retrieval_contract (3).
> 
> ## Context
> - All three blocked, not attempted — they need a live dev server.
> - All three spend real tokens, so manual-only, never CI.
> - `--skip-sitemap` doesn't exist; it's silently ignored.
>   Blockers: - All three blocked, not attempted — they need a live dev server.
> - decision from jeffrey:
>   Decisions: - **2 — Run the handoff tier whole.** `node scripts/run-bench.cjs --tier handoff`, 31 cases, read the exit code.
> how much is this going to cost???
> 
> 4. go ahead and run those. you'll need to manually start the pluto dev server
> - decision from jeffrey:
>   Decisions: so what's the status
> - decision from jeffrey:
>   Decisions: so what's the status
> - decision from jeffrey:
>   Decisions: so what's the status
> - agent_handoff from codex:
>   Facts: ## Problem
> 
> Steps 2, 4, and 5 remain unverified after the prior attempt was interrupted by expired OAuth.
> 
> ## Solution
> 
> - **Step 2:** Not completed. The 31-case handoff tier was not run, so there is no exit code.
> - **Step 4:** Not completed. The Pluto dev server was not started; cases h17–h22 were not executed.
> - **Step 5:** Not completed. Label widening remains blocked pending live-server results.
> 
> ## Context
> 
> Only steps 1 and 6 are confirmed complete. No scripts or servers were started during this status check.
>   Blockers: - **Step 5:** Not completed. Label widening remains blocked pending live-server results.
> - decision from jeffrey:
>   Decisions: what's the status of asnwering what's the cost of the full bench run dumbass
> - agent_handoff from codex:
>   Facts: ## Problem
> 
> The 31-case handoff tier has not been run. Jeffrey canceled it on September 17 because it was too expensive.
> 
> ## Solution
> 
> Estimated cost: roughly **$10–$25** for all **83 live agent turns**, depending on token volume, caching, and artifact generation.
> 
> Exit code: **unavailable**, because `node scripts/run-bench.cjs --tier handoff` was never executed.
> 
> ## Context
> 
> No saved handoff results or cost logs were found locally. The exact cost can only be calculated after a run from its recorded token usage.

### <a id="13"></a>13. short_term_memory:9544242c-6e30-4199-afbb-f5c6f96c6997 archived 2026-10-09

- Date: 2026-10-09
- Source: short_term_memory:9544242c-6e30-4199-afbb-f5c6f96c6997
- Reason: One-off CON-196 check; the fix already shipped on main.
- Proposal: 2da6fd8c-a4a6-4b2a-98f4-f0864146038b
- Removal: none (rebuildable projection)

> ### CON-196 Surface profile connection errors in the frontend
> Conversation: 9544242c-6e30-4199-afbb-f5c6f96c6997
> Project: Connectors
> - agent_handoff from claude:
>   Facts: ## Problem
> CON-196 asks that when connecting a profile fails, the UI show the underlying backend error (e.g. `Org profile '...' is not active (status: ERROR)`) instead of a generic "Failed to connect" toast.
> 
> ## Solution
> No code change was needed — this is already shipped on `main` and present in this worktree's HEAD (`ae0616564e`), via commit `f3dd4a5519` ("fix(frontend): surface connector profile errors [linear:CON-196]", PR #16013, merged Sep 11):
> 
> - `frontend/src/hooks/use-profile-connection-error-handler.ts` parses the RFC 7807 error body (`ProfileConnectionErrorResponseSchema`) and turns `title` into the `Error.message`, which `handleApiError` then shows as the toast description instead of the generic title.
> - Wired into every connect mutation in `use-gateway.ts` (`useConnectOrganizationProfile`, `useConnectCgProfile`, `useCreateOAuthProfileMy`, `useCreateApiKeyProfileMy`, `useCreatePasswordProfileMy`) and `use-connector-auth.ts`.
> - Behind the `actionagentmanageconnectorsv2` flag; legacy (V2-off) path intentionally keeps old behavior per an existing code comment.
> 
> Verification (this run): ran `vitest run` on the three relevant suites directly (not full suite):
> - `use-profile-connection-error-handler.test.ts` — 8/8 pass, including the exact ticket example (`"Org profile 'org-profile-1' is not active (status: ERROR)"`).
> - `use-gateway.test.ts`, `use-connector-auth.test.tsx`, `cg-profiles-service.test.ts` — 27/27 pass.
> 
> This is source/unit-test verification only, not a browser repro — no dev server was started this run. `git status` is clean; no diff to commit.
> 
> ## Context
> - Linear ticket CON-196 still shows `in_progress`, but the code is already on `main`; likely the ticket just wasn't closed after the PR merged. I did not mutate Linear (no external-mutation capability this turn) — flag this to Jeffrey to close or confirm there's residual scope.
> - An unrelated branch `con-196-error-ux-prototype` also references CON-196 but is a stale, heavily diverged prototype (6800+ file diff) — not relevant here, ignored.
>   Blockers: CON-196 asks that when connecting a profile fails, the UI show the underlying backend error (e.g. `Org profile '...' is not active (status: ERROR)`) instead of a generic "Failed to connect" toast.
> - `frontend/src/hooks/use-profile-connection-error-handler.ts` parses the RFC 7807 error body (`ProfileConnectionErrorResponseSchema`) and turns `title` into the `Error.message`, which `handleApiError` then shows as the toast description instead of the generic title.
> - `use-profile-connection-error-handler.test.ts` — 8/8 pass, including the exact ticket example (`"Org profile 'org-profile-1' is not active (status: ERROR)"`).
> - An unrelated branch `con-196-error-ux-prototype` also references CON-196 but is a stale, heavily diverged prototype (6800+ file diff) — not relevant here, ignored.
>   Evidence: - `use-profile-connection-error-handler.test.ts` — 8/8 pass, including the exact ticket example (`"Org profile 'org-profile-1' is not active (status: ERROR)"`).
> - `use-gateway.test.ts`, `use-connector-auth.test.tsx`, `cg-profiles-service.test.ts` — 27/27 pass.
> This is source/unit-test verification only, not a browser repro — no dev server was started this run. `git status` is clean; no diff to commit.

### <a id="14"></a>14. short_term_memory:9beb2b70-dff2-448c-8428-e27bea239a12 archived 2026-10-09

- Date: 2026-10-09
- Source: short_term_memory:9beb2b70-dff2-448c-8428-e27bea239a12
- Reason: One-off Pluto golden-dataset plan for a single conversation.
- Proposal: 2da6fd8c-a4a6-4b2a-98f4-f0864146038b
- Removal: none (rebuildable projection)

> ### golden dataset for pluto
> Conversation: 9beb2b70-dff2-448c-8428-e27bea239a12
> Project: Pluto
> - agent_handoff from claude:
>   Facts: ## Problem
> Pluto's current tests can't serve as a golden dataset:
> - The first ten questions still test the old internet-provider sample, not the 58 Shade Store files. For example, `q02-key-services.yaml` expects "fiber internet."
> - Software wrote those questions, not a strategist.
> - Only 8 of 69 questions have hand labels. Those labels can't show what Pluto missed.
> 
> ## Solution
> - Taylor writes about 50 questions.
> - Each question gets a type, difficulty, expected behavior, 2–6 key facts, a reference answer and wrong claims to avoid.
> - Each key fact cites a file, page and quote, never a database ID.
> - A second person checks about 10 questions.
> - About 15 stay held back for final checks.
> - Start with 10.
> 
> ## Context
> - Brief: `~/Documents/Workbench/documents/pluto-golden-dataset-brief.md`
> - Your decisions: total size, whether to replace the old questions, who reviews (you or Brandon), whether client quotes can go in the repo, and spreadsheet or YAML.
> - No code changed.
>   Blockers: Pluto's current tests can't serve as a golden dataset:
> - Only 8 of 69 questions have hand labels. Those labels can't show what Pluto missed.
>   Evidence: Pluto's current tests can't serve as a golden dataset:
> - The first ten questions still test the old internet-provider sample, not the 58 Shade Store files. For example, `q02-key-services.yaml` expects "fiber internet."
> - No code changed.
> - agent_handoff from codex:
>   Facts: ## Problem
> 
> No universal format exists. Pluto currently uses 69 YAML cases and 133 labeled chunks, but its Shade Store corpus is not frozen and documentation is stale.
> 
> ## Solution
> 
> Have Taylor curate 20–50 spreadsheet rows containing: ID, category, realistic prompt, reference facts, required sources/pages/quotes, forbidden claims, answerable/abstain, difficulty, and provenance. Include normal, edge, adversarial, positive, and negative cases. Two experts should independently review labels.
> 
> Engineering later converts approved rows into Pluto’s [question YAML](/Users/jeffrey.lu/dev/Pluto-Alpha/evals/bench/questions) and [chunk worksheets](/Users/jeffrey.lu/dev/Pluto-Alpha/evals/bench/labeling). This matches [OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices), [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), and [NIST](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/).
> 
> ## Context
> 
> Jeffrey must choose workflows, corpus snapshot, reviewer, and release thresholds. Risks: leakage, ambiguity, stale chunk IDs, and overfitting. No files changed; validation passes 133/133.
>   Decisions: Have Taylor curate 20–50 spreadsheet rows containing: ID, category, realistic prompt, reference facts, required sources/pages/quotes, forbidden claims, answerable/abstain, difficulty, and provenance. Include normal, edge, adversarial, positive, and negative cases. Two experts should independently review labels.
> Engineering later converts approved rows into Pluto’s [question YAML](/Users/jeffrey.lu/dev/Pluto-Alpha/evals/bench/questions) and [chunk worksheets](/Users/jeffrey.lu/dev/Pluto-Alpha/evals/bench/labeling). This matches [OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices), [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), and [NIST](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/).
> Jeffrey must choose workflows, corpus snapshot, reviewer, and release thresholds. Risks: leakage, ambiguity, stale chunk IDs, and overfitting. No files changed; validation passes 133/133.
>   Evidence: Jeffrey must choose workflows, corpus snapshot, reviewer, and release thresholds. Risks: leakage, ambiguity, stale chunk IDs, and overfitting. No files changed; validation passes 133/133.
> - synthesis from system:
>   Facts: Synthesis:
> ## Problem
> 
> Current 69 questions reference an old sample, were software-generated, lack hand labels, and can't reliably ground evals.
> 
> ## Solution
> 
> Both responses converge on the same approach: have Taylor write ~50 questions with type, difficulty, facts (file/page/quote), expected behavior, and wrong claims, reviewed by a second person, then convert to YAML. Claude recommends starting with 10 first to validate the format before scaling.
> 
> ## Context
> 
> Jeffrey decides: size, replace/supplement, reviewer identity, client-quote policy, and authoring format. Unverified: whether the brief exists at the cited path and whether the sample blocker is root cause or symptom.
>   Blockers: Current 69 questions reference an old sample, were software-generated, lack hand labels, and can't reliably ground evals.
> Jeffrey decides: size, replace/supplement, reviewer identity, client-quote policy, and authoring format. Unverified: whether the brief exists at the cited path and whether the sample blocker is root cause or symptom.

### <a id="15"></a>15. short_term_memory:c62b8755-4deb-4648-a232-4046586dd42f archived 2026-10-09

- Date: 2026-10-09
- Source: short_term_memory:c62b8755-4deb-4648-a232-4046586dd42f
- Reason: One-off diagram rewrite; the design doc is the lasting artifact.
- Proposal: 2da6fd8c-a4a6-4b2a-98f4-f0864146038b
- Removal: none (rebuildable projection)

> ### i need an architectural diagram for the new next.js endpoint that we're using fo
> Conversation: c62b8755-4deb-4648-a232-4046586dd42f
> - agent_handoff from claude:
>   Facts: ## Problem
> The old diagram showed Vite and Next.js sharing one Manage Connectors page. That was wrong.
> 
> ## Solution
> I rewrote `~/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md`:
> - Flags off: Vite app → Vite's own Manage Connectors.
> - Flags on: Next.js → a separate, new Manage Connectors.
> - Only the backend APIs are shared. No shared panel appears.
> 
> ## Context
> - **Code conflict:** on branch `jeffrey/CON-466/manage-connectors-new-stack`, Vite's `MigratedConnectorsPage` still loads `@web/connectors`, the same package as Next.js. The diagram follows your design, not that branch.
> - **Not checked:** no Mermaid renderer is installed, so I haven't confirmed the diagram renders.
> - **Still blocked:** I can't post to Linear. You'll need to paste the doc in.
>   Blockers: - **Still blocked:** I can't post to Linear. You'll need to paste the doc in.
> - decision from jeffrey:
>   Decisions: also i'm missing claude's diagrams from the doc!
>   Blockers: also i'm missing claude's diagrams from the doc!
> - synthesis from system:
>   Facts: Synthesis:
> ## Problem
> 
> The diagram incorrectly showed Vite and Next.js sharing one Manage Connectors implementation.
> 
> ## Solution
> 
> Both agents rewrote `/Users/jeffrey.lu/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md` to show separate implementations:
> - **Flags off:** Vite renders its own Manage Connectors.
> - **Flags on:** Next.js renders a separate, new Manage Connectors.
> - Only backend APIs are shared.
> 
> ## Context
> 
> - **Code vs. diagram gap:** Claude flagged that the branch `jeffrey/CON-466/manage-connectors-new-stack` still has Vite loading `@web/connectors` (the same package as Next.js), contradicting the intended architecture. The diagram reflects the design; the code doesn't yet.
> - **Not verified:** Mermaid rendering was not tested — no renderer installed.
> - **Blocked:** Publishing to Linear requires an external mutation capability this run doesn't have. You'll need to paste the document there manually.
>   Blockers: - **Blocked:** Publishing to Linear requires an external mutation capability this run doesn't have. You'll need to paste the document there manually.
>   Evidence: - **Not verified:** Mermaid rendering was not tested — no renderer installed.
> - agent_handoff from claude:
>   Facts: ## Problem
> Claude's three diagrams were lost when a later rewrite overwrote the shared file.
> 
> ## Solution
> I restored them in `~/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md`, below the overview:
> - **Request flow:** the flags send users to Vite or to Next.js. Each app has its own page.
> - **Rollout and safety:** the flag checks, plus a fallback to Vite if the new page crashes.
> - **End state:** the Next.js page moves to `writer-monorepo/frontend`, and the Vite page is retired.
> 
> ## Context
> - I redrew Vite and Next.js as separate pages, per your correction.
> - Backup: `/tmp/manage-connectors-doc-before-restore.md`.
> - Checked: 4 diagrams, no shared-panel wording left.
> - Not checked: whether the diagrams draw. No renderer here.
> - Blocked: you'll need to paste it into Linear yourself.
>   Blockers: - Blocked: you'll need to paste it into Linear yourself.
> - decision from jeffrey:
>   Decisions: 1. Summary
> 
> The migration keeps the existing Manage Connectors URL while flagging which frontend host serves it. 
> 
> We've added a temporary new Next.js endpoint to enable feature development inside of fe.web-app. Eventually this will be removed and point to the new frontend once migrated to the writer-monorepo. The new Next.js app is the organization-scoped entry point for the migrated page. It renders the shared Manage Connectors experience; the browser continues to call Writer's existing APIs directly. Next.js is the page host, not a new backend or API proxy.
> 
> Notes
> 
> Manage Connectors has two separate frontends during the migration. They do not share a page, panel, or UI.
> 
> The existing Vite app serves its own Manage Connectors experience. Production traffic goes there today.
> 
> The new Next.js endpoint serves a separate, rebuilt Manage Connectors experience on an entirely new stack compatible with the writer-monorepo.
> 
> Rollout flags decide which app serves the request. Only the backend APIs are common to both.
> 
> Neither app adds a Next.js API proxy or server-side data layer. Both call the backend from the browser.
> 
> Final destination: the Next.js app in writer-monorepo/frontend. Then the Vite experience is retired.
> 
> Overview
> 
> flowchart LR
>   browser["Admin browser"] --> url["Manage Connectors URL<br/>/aistudio/organization/:orgId/connectors"]
>   url --> routing{"Migration routing<br/>feature flags"}
>   subgraph vitePath["Vite path — current"]
>     vite["Vite app<br/>existing console shell"]
>     viteUi["Vite Manage Connectors<br/>existing implementation"]
>     vite --> viteUi
>   end
>   subgraph nextPath["Next.js path — migration target"]
>     next["Next.js endpoint<br/>/aiStudio/:orgId/connectors"]
>     nextUi["Next.js Manage Connectors<br/>new, separate implementation"]
>     next --> nextUi
>   end
>   routing -->|"Flags off"| vite
>   routing -->|"Flags on"| next
>   viteUi --> apis
>   nextUi --> apis
>   subgraph apis["Writer backend APIs — unchanged"]
>     gateway["Connector Gateway<br/>connectors and profiles"]
>     platform["Platform APIs<br/>identity, permissions, teams"]
>     analytics["Observability API<br/>connector analytics"]
>   end
> 
> 1. Request flow
> 
> flowchart LR
>   user["Admin's browser"]
>   gate{"Rollout gate<br/>aisManageConnectorsV2 = true<br/>AND connector-gateway = true"}
>   subgraph vite["service.writer-app (Vite, deployed via nginx)"]
>     shell["Console shell<br/>sidebar · theme · session · router"]
>     viteUi["Vite Manage Connectors<br/>existing implementation"]
>     shell --> viteUi
>   end
>   subgraph next["next.writer-app (Next.js endpoint, not deployed)"]
>     route["/aistudio/organization/:orgId/connectors<br/>(rewritten to the org-scoped App Router page)"]
>     nextUi["Next.js Manage Connectors<br/>new, separate implementation"]
>     host["Host context snapshot<br/>org · user · permissions · flags"]
>     cache["TanStack Query<br/>server state"]
>     atoms["Jotai<br/>org-scoped UI state"]
>     route --> nextUi
>     host --> nextUi
>     nextUi --- cache
>     nextUi --- atoms
>   end
>   subgraph backend["Writer backend APIs — the only shared layer"]
>     cgw["Connector Gateway<br/>/api/connector-gateway/v1/…<br/>connectors · profiles"]
>     platform["Platform API<br/>auth/permission · user profile ·<br/>org users · teams"]
>     obs["Observability API<br/>connector governance analytics"]
>   end
>   user --> gate
>   gate -- "no" --> shell
>   gate -- "yes" --> route
>   viteUi -- "browser fetch, session cookie" --> backend
>   cache -- "browser fetch, session cookie" --> cgw
>   cache -- "browser fetch, session cookie" --> platform
>   cache -- "browser fetch, session cookie" --> obs
> 
> 2. Who owns what
> 
> Layer
> 
> Owns
> 
> Does not own
> 
> Manage Connectors URL
> 
> Stays the same before and after cutover
> 
> Which app answers it
> 
> Rollout gate
> 
> Sends each request to Vite or Next.js
> 
> Any page UI
> 
> Vite app (service.writer-app)
> 
> Shell, session, and its own existing Manage Connectors page. Unchanged by this migration
> 
> The new Next.js page
> 
> Next.js endpoint (next.writer-app)
> 
> The new Manage 
> - agent_handoff from claude:
>   Facts: ## Problem
> You asked for two diagrams, not four: the overall architecture, and what runs in production.
> 
> ## Solution
> I rewrote `~/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md`:
> - **Architecture:** flags send each request to the Vite page or the Next.js page. Both call the same backend APIs. A dotted line shows the later move to `writer-monorepo/frontend`.
> - **Production:** the Vite app, served by nginx, handles every request. Next.js isn't deployed.
> - I changed "shared" to "new" in your summary because it contradicted your notes.
> 
> ## Context
> - **Production facts:** checked on `fe.web-app` `origin/master` (`ac9ca18729`). The `aisManageConnectorsV2` flag isn't there yet. The `connector-gateway` flag picks Connector Gateway or MCP Gateway.
> - **Checked:** both diagrams pass Mermaid's syntax check. I didn't see how Linear draws them.
> - **Backup:** `/tmp/manage-connectors-doc-before-two-diagram-rewrite.md`.
> - **Blocked:** I can't post to Linear, so you'll need to paste the doc in.
>   Blockers: - **Blocked:** I can't post to Linear, so you'll need to paste the doc in.
>   Evidence: - I changed "shared" to "new" in your summary because it contradicted your notes.
> - decision from jeffrey:
>   Decisions: ok but the nextjs experience IS being served in production. it's there. explain how
> - agent_handoff from claude:
>   Facts: ## Problem
> I was wrong last time. The Next.js server isn't deployed, but the new page's code is.
> 
> ## Solution
> - The page lives in a shared library, `libs/connectors` (`@web/connectors`).
> - The Next.js app renders it in `apps/next.writer-app/src/app/aiStudio/[orgId]/connectors/page.tsx`.
> - The Vite app shows the same code inside its console through `EmbeddedManageConnectorsPage` in `MigratedConnectorsPage.tsx`.
> - `ConsolePage.tsx` turns it on only when `aisManageConnectorsV2` and `connector-gateway` are both on.
> - `release.yml` rebuilds the Vite app when `libs/connectors/**` changes. It then ships in the normal nginx image.
> 
> ## Context
> - **Checked:** `fe.web-app` `origin/develop` (`79234d8b71`).
> - **Not checked:** the live site, or current `origin/master`. My local copy dates from Sep 30.
> - **Linear doc:** its production diagram is still wrong. I haven't changed it.
>   Evidence: - **Linear doc:** its production diagram is still wrong. I haven't changed it.
> - decision from jeffrey:
>   Decisions: fix the fucking doc
> - agent_handoff from claude:
>   Facts: ## Problem
> The doc wrongly called the new page local only. It's live in production inside the Vite app. Only the Next.js server isn't deployed.
> 
> ## Solution
> I rewrote `~/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md`:
> - **Architecture:** the new page is in the shared `libs/connectors` library. Vite shows it when `aisManageConnectorsV2` and `connector-gateway` are both on. Otherwise, or if it fails, Vite shows the legacy page. Next.js uses the same library but runs only locally.
> - **Production:** browser → Vite → flag check → new or legacy page → backend APIs. The Next.js server is marked not deployed.
> 
> ## Context
> - Checked against `fe.web-app` `origin/develop` (`79234d8b71`).
> - The diagrams weren't test-rendered because no Mermaid tool is installed. They're unchecked in Linear.
> - You'll need to paste the doc into Linear yourself.
>   Evidence: - The diagrams weren't test-rendered because no Mermaid tool is installed. They're unchecked in Linear.
> - decision from jeffrey:
>   Decisions: what the fuck? you literally didn't incorporate ANY OF THIS: 
> 
> - The page lives in a shared library, `libs/connectors` (`@web/connectors`).
> - The Next.js app renders it in `apps/next.writer-app/src/app/aiStudio/[orgId]/connectors/page.tsx`.
> - The Vite app shows the same code inside its console through `EmbeddedManageConnectorsPage` in `MigratedConnectorsPage.tsx`.
> - `ConsolePage.tsx` turns it on only when `aisManageConnectorsV2` and `connector-gateway` are both on.
> - `release.yml` rebuilds the Vite app when `libs/connectors/**` changes. It then ships in the normal nginx image.
> 
> in the production deployment diagram you stupid motherfucker? or write anything explaining that
> - agent_handoff from claude:
>   Facts: ## Problem
> You were right. The production diagram skipped all five facts you gave me, and the doc never explained them.
> 
> ## Solution
> I rewrote section 2 of `~/Documents/Workbench/documents/manage-connectors-nextjs-architecture-linear-doc.md`.
> - **Diagram:** `libs/connectors` (`@web/connectors`) feeds the Next.js `page.tsx`. It also feeds the Vite app's `MigratedConnectorsPage.tsx`, which renders `EmbeddedManageConnectorsPage`. `ConsolePage.tsx` shows the new page only when `aisManageConnectorsV2` and `connector-gateway` are both on. `release.yml` rebuilds the Vite app on `libs/connectors/**` changes and ships the normal nginx image.
> - **Text:** five numbered steps, one per fact, each naming its file.
> 
> ## Context
> - I checked each fact against `fe.web-app` `origin/develop` @ `79234d8b71`.
> - Both diagrams render, and all five file names show up.
> - It's not posted to Linear. This run can't make external changes.
>   Blockers: - It's not posted to Linear. This run can't make external changes.
