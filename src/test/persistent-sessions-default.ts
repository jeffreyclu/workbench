// Tests exercise the per-run agent path unless they opt into persistent
// sessions themselves (agent-runner.test.ts and shared-room.test.ts set '1'
// around the cases that need it). Production defaults to sessions on, so the
// suite pins the opt-out here instead of in every file that spawns a reply.
process.env.WORKBENCH_PERSISTENT_SESSIONS ??= '0';
