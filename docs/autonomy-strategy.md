# Workbench self-automation: strategy and the 20% number

## The answer up front

**20% of your weekly Claude limit buys roughly 600 autonomous Sonnet runs per week — about 85 a day.**

You're on the $100/month plan for both Claude and Codex, so the bracket collapses to its lower row. That's the number to build against. Codex moves to $200/month next month, which roughly doubles the Codex side of the budget — the design below handles that by keeping each provider's ceiling a stored value, not a constant in code.

Quota is not the thing that will stop this. Review capacity and wall-clock time are. Build the meter first anyway, because a budget you can't measure isn't a budget.

Codex's earlier position was that Claude has to sit this out, because Claude Code gives no official "percent of weekly limit used" through its non-interactive stream. That part is true. The conclusion isn't. Workbench doesn't need Anthropic's percentage — it needs *a* number it can measure and then calibrate against the percentage you can already see. That's the design below.

---

## How the 20% was estimated

### The unit

Claude's weekly limit isn't published as a token count, so we need a stand-in. Use **Sonnet-equivalent tokens (SET)** — every token normalized to what one Sonnet input token costs:

| Token kind | Weight |
|---|---|
| Fresh input | ×1 |
| Cache write | ×1.25 |
| Cache read | ×0.1 |
| Output | ×5 |

Then multiplied by model: Haiku ×0.33, Sonnet ×1, Opus ×5. These are the published price ratios, used as a proxy for how much of the limit each token consumes.

Workbench already captures every input the formula needs. `src/server/agent-runner.ts:236-253` parses `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens` from both providers' streams. `src/server/model-pricing.ts` already holds the per-model rates. Nothing new has to be invented to count.

### What you actually consumed

Measured directly from your Claude Code transcripts in `~/.claude/projects/`:

| Day | Sonnet-equivalent tokens | Notes |
|---|---|---|
| 2026-08-18 | ~116M | Opus-dominated |
| 2026-08-19 | ~301M | Opus-dominated, heaviest day |
| 2026-08-20 | ~0.1M | Haiku only |
| 2026-08-22 | ~7M | partial day |

Roughly **93% of that is Opus**. Your interactive work is what makes a heavy day heavy — not volume of sessions, but model tier. This is exactly why your "Sonnet and below" rule for autonomy is the right call: the same run on Sonnet costs one fifth of what it costs on Opus.

### What a Workbench run costs

From 465 completed Claude Sonnet runs already in `agent_runs`:

- Average 478,533 input tokens, 2,971 output tokens
- Average estimated cost **$0.32**
- Upper-bound conversion: **~107,000 SET per run** (this treats every input token as fresh input, which it isn't — most are cache reads. Real cost is lower, so the estimate errs toward spending less.)

Haiku runs average $0.018 — effectively free against the budget.

### The division

Jeffrey confirmed the plan: **$100/month on Claude, $100/month on Codex, with Codex going to $200/month next month.** That fixes the Claude row:

| Weekly ceiling | 20% slice | Autonomous Sonnet runs/week | Per day |
|---|---|---|---|
| ~333M SET ($100/mo Claude) | 67M SET | **~620** | ~88 |

**Plan on 600 runs a week.** If calibration shows more headroom, raise it then.

### The Codex side, and next month's change

Codex's ceiling is not estimated the same way — Codex reports its own usage percentage directly, so Workbench reads the real number instead of inferring one. What the tier change means practically: when the $100 → $200 upgrade lands, Codex's weekly allowance roughly doubles, so the same 20% rule yields about twice the autonomous Codex work.

The design consequence is a rule, not a number: **store each provider's ceiling as a value Workbench can update, and never hard-code it.** On the Codex side the upgrade is absorbed automatically, because the governor works from reported percentages. On the Claude side, the stored ceiling is replaced by the calibration below. Neither path needs a code change when a plan changes.

One thing worth flagging: your single heaviest day (301M SET) is already *larger than the entire 20% autonomous slice for the week*. Your own Opus sessions, not the robot, are what will exhaust a week. That has a direct consequence for the design — the autonomous slice must be **reserved up front**, not handed whatever is left over on Friday.

---

## The design

### 1. A meter that reads both providers

Workbench computes its own SET exactly, from data it already stores. For usage it *didn't* originate — your interactive Claude Code sessions — it reads `~/.claude/projects/**/*.jsonl` directly. That's verified working; the day table above was produced that way.

Codex is easier: its app-server protocol exposes `account/rateLimits/read` and its event stream carries a usage percentage and reset time, as Codex noted. Workbench ignores those fields today. Read them.

### 2. Calibration — this is what unblocks Claude

Workbench can't read Claude's official percentage. It can continuously read the local transcript traffic, but Anthropic exposes the weekly percentage only in interactive `/usage`. Run `npm run usage:calibrate` whenever an agent needs current local Claude/Codex totals; it reads both providers' local logs and refuses to mistake Codex's short rate-limit window for a weekly calibration. Once or twice a week, an interactive Claude `/usage` observation remains the authoritative input for Claude's weekly ceiling.

Workbench then solves for the real ceiling:

```
ceiling = (Workbench's own SET + your interactive SET) ÷ observed_fraction
```

After one calibration the ceiling is measured, not assumed. Every later calibration corrects drift. Two numbers, twice a week, and the estimate above stops being an estimate.

Until the first calibration, use the pessimistic ceiling (333M SET/week) so the system under-spends rather than over-spends.

### 3. The governor

One gate that every autonomous dispatch passes. Keeping Codex's structure, with the Claude specifics filled in:

- Global kill switch; per-provider enable.
- Separate weekly window per provider, tracked against that provider's own reset date.
- **Hard model allowlist: Haiku and Sonnet only.** Task classification may pick a deeper effort level but can never raise the tier. Opus is never available to an autonomous run.
- **Estimate, reserve, dispatch, reconcile.** Before dispatch, estimate cost from the historical average for that agent+model (already in `agent_runs`). Reserve it atomically so two runs can't spend the same allowance. After the run, replace the estimate with the actual.
- **Spend to 16%, alarm at 20%.** The 4-point gap absorbs the fact that SET weights are a proxy for accounting Anthropic doesn't publish.
- **Refuse to dispatch** when: the kill switch is off, no calibration in the last 14 days, the transcript scan fails or returns nothing, the reset date looks inconsistent, or reserved + spent has reached the slice.
- One autonomous run at a time to start.
- Manual runs never blocked, and recorded separately from autonomous ones.

Separating manual from autonomous needs a new column on `agent_runs`. That is a forward-only migration with an upgrade-path test starting from a database that has already recorded the current migration set — fresh-database coverage alone won't catch it.

### 4. Phasing

Each phase ships and runs clean before the next starts.

1. **Meter only.** Weekly dial in the UI showing SET spent per provider, split manual vs autonomous. No dispatch, nothing spent. This proves the number is real before any money rides on it.
2. **Calibrate.** The `/usage` input, and the solve for the true ceiling.
3. **Governed execution.** Autonomous runs against *existing* tasks in your priority order, Sonnet/Haiku, one at a time, governor enforcing. Skips anything completed, archived, blocked, prerequisite-blocked, or owned by you.
4. **Autonomous task creation.** Discovery proposes new tasks and a priority position. It proposes; it doesn't execute what it proposed in the same cycle.
5. **Self-evolution.** Workbench changing its own source. Only after phases 1–4 have run clean for two full weekly windows. Code changes still need tests and the `frontend-reviewer` pass before anything is promotion-ready — autonomy speeds up the writing, not the approving.

---

## Risks

- **The SET weights are a guess at Anthropic's real accounting.** Calibration fixes the scale but not the shape — if cache reads count for more than a tenth of a fresh token, the model is wrong in a way calibration partly masks. Mitigated by recalibrating weekly and by the 16%/20% margin.
- **The transcript scan only sees this machine.** Usage from claude.ai or another laptop is invisible to it. This fails in the safe direction: unseen usage makes the calibrated ceiling look *lower* than it is, so Workbench spends less.
- **Failed work still costs.** A run that burns quota and then fails review is pure loss. Phase 3's one-at-a-time limit keeps that bounded while the failure rate is unknown.
- **The Claude ceiling is still inferred, even though the tier is now known.** Anthropic doesn't publish the weekly limit as a token count, so 333M SET/week is a derivation from price ratios, not a published figure. Knowing the plan removed the bracket, not the inference. The first `/usage` calibration is what makes it measured.
- **Plan changes are a live variable.** Codex goes from $100 to $200 next month. If any ceiling gets hard-coded, that upgrade silently under-spends the budget by half for as long as nobody notices.

---

*Estimates derived 2026-08-22 from `~/.claude/projects/**/*.jsonl` and the `agent_runs` table in `data/workbench.db`. Plan tiers ($100/month Claude, $100/month Codex rising to $200/month next month) are as stated by Jeffrey on 2026-08-22; nothing on this machine records them. Anthropic does not publish weekly limits as token counts, so the ceiling figure is inferred from published price ratios and stays unverified until the first `/usage` calibration.*
