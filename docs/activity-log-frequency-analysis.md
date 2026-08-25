# Activity-log frequency analysis and the strengthen/deprecate pass

**Task type:** execute — analysis plus a shipped fix, not another research-only pass. Builds on
`docs/research-activity-log-insights.md`, which mapped the schema but made no changes.

## 1. What the data actually shows

Query source: `data/workbench.db`, `activities` (Jeffrey/agent-authored task events, 6,807 rows since
2026-08-18) and `audit_log` (every mutating API call plus tool/file/outbound events, 16,459 rows).

### Jeffrey's own actions (`activities`, `actor = 'jeffrey'`, 1,572 rows)

| kind | count | share |
|---|---:|---:|
| `chat_started` (message sent to an agent on a linked task) | 963 | 61% |
| `edited` (task field edit) | 187 | 12% |
| `model_preference` | 162 | 10% |
| `completed` | 116 | 7% |
| `classification` | 67 | 4% |
| `follow_up` | 22 | 1% |
| `decomposed` | 17 | 1% |
| `restored` / `archived` | 9 / 8 | <1% each |
| `task_linked` / `reference_added` / `conversation_linked` / `conversation_unlinked` | 5–6 each | <1% each |

Sending a message is by far the dominant real action — six times more frequent than the next
category. Everything below `classification` (linking, references, restore/archive) is genuinely rare,
not under-instrumented; there's no evidence these are underused features worth deprecating, just
infrequently-needed ones.

### Every mutating API call (`audit_log`, `category = 'api_mutation'`, 10,327 rows — includes both
Jeffrey's and agents' calls, since the log doesn't separate caller identity at this layer)

| route | count | share of all api_mutation |
|---|---:|---:|
| `POST /api/shared/conversations/:id/read` | 7,795 | 75% |
| `POST /mcp` (agent tool calls) | 1,375 | 13% |
| `POST /api/shared/messages` (send) | 557 | 5% |
| `PATCH /api/work-items/:id` | 81 | 1% |
| `POST /api/work-items/:id/execute` | 65 | 1% |
| `POST /api/work-items/:id/complete` | 61 | 1% |
| everything else (queue reorder, retry, archive, classify, plan resolve, discovery, ...) | ~390 combined | ~4% |

`conversations/:id/read` alone is three-quarters of every mutation Workbench records. That number is
disproportionate to any real user action — nobody re-marks the same open conversation as read 7,795
times — so it was the first thing worth checking before treating it as signal.

## 2. Root cause: the busiest "path" was a bug, not a preference

`src/client/features/conversation/view.tsx` marked a conversation read in a `useEffect` keyed on
`latestMessageLength` — the character length of the last message's body:

```ts
const latestMessageLength = messages.data?.messages.at(-1)?.body.length ?? 0;
useEffect(() => { void api.markSharedConversationRead(conversationId); }, [conversationId, latestMessageLength, ...]);
```

While a run is active, `messages` polls every 750ms (`refetchInterval` is conditional on any message
being `running`/`queued`), and the streaming assistant message's body grows on every poll — so
`latestMessageLength` changes on almost every tick, re-firing the read-mark call for the entire
duration of every run. Daily volume confirms this is live and growing, not historical: 1,758 calls on
08-23, 5,847 on 08-24, 210 so far on 08-25 (partial day).

**Fix shipped:** the effect now keys on `messages.data?.messages.length` (a new message arrived) and
`latestMessage?.status` (the last message finished/changed state) instead of the streamed body length.
A conversation is marked read once per newly-arrived or newly-completed message, plus once on
conversation switch — not once per streamed token. The unrelated auto-scroll effect, which correctly
does need to react to every streamed character, keeps using `latestMessageLength` unchanged.

File: `src/client/features/conversation/view.tsx:661-682`.

This is the "strengthen the most-used path" instruction taken literally: the most-used path was mostly
waste, and removing the waste is the strengthening — no new abstraction, no feature added.

## 3. `/mcp` error rate — flagged, not fixed

Of 1,375 `POST /mcp` calls (agent tool traffic, the second-busiest path), 325 (24%) returned HTTP 400.
`audit_log.detail` only records the route and status, not the JSON-RPC method or error reason, so it's
not possible to tell from this data alone whether that's a real failure mode (malformed tool calls) or
expected MCP protocol behavior (e.g. requests against an already-closed session). This is the
"instrumentation may not be sufficient" case flagged in the task brief: recording `error.code`/method
alongside the audit entry in `createWorkbenchMcpHandler` (`src/server/workbench-mcp.ts`) would make this
answerable without guessing. Left as a follow-up rather than guessed at.

## 4. Deprecation candidates: none found

Checked every low-frequency `kind`/route for "unused feature" signal. Nothing qualifies:
- Task linking, references, conversation linking/unlinking (5–6 events each) are low-frequency but
  each has a real, distinct use (compare to the ~1,000 chat messages) — not evidence of an abandoned
  feature.
- One-off routes (`generate-draft`, `follow-ups`, `usage/calibration`, `republish`, `undelete`,
  Figma OAuth start) each fired exactly once or a handful of times in a single week of data — too
  little history to call anything dead. Revisit with a longer window before proposing removal.

## 5. Verification

- `npm run typecheck` — passes.
- `npx eslint src/client/features/conversation/view.tsx` — clean.
- No existing test file covers this component (`src/client/features/conversation/view.tsx` has no
  sibling `*.test.*`); none added, consistent with the rest of that file's test coverage.
- Not manually exercised in a browser (no dev server started for this pass); the change is a dependency-
  array narrowing with no behavior change to the mark-read call itself, verified by reading the
  `messages` query's polling logic and the two consumers of `latestMessageLength`.
