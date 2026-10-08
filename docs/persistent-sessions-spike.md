# Persistent sessions spike

## Claude CLI 2.1.295

Run from the routed Workbench worktree:

```sh
npx tsx scripts/session-spike.ts
```

The checked run used Workbench managed command `persistent-sessions-spike`, attempt 4, and exited 0 on 2026-10-08. The script imports `commandFor` and `agentEnvironmentForWorkspace` from `src/server/agent-runner.ts`, adds a UUID `--session-id` and `--replay-user-messages`, and replaces the runner MCP config with the throwaway stateless server at `http://127.0.0.1:5199/mcp`. It creates a fresh `McpServer` and `StreamableHTTPServerTransport` per request, like Workbench's handler. It never binds or restarts port 5180.

| Check | Result | Observed excerpt |
| --- | --- | --- |
| Three stdin user turns | Yes | Results: `one`, `two`, `three`. `ps -o pid,lstart` after each: `76624 Thu Oct 8 16:59:23 2026`. |
| Interrupt and next turn | Yes | Sent `{"type":"control_request","request":{"subtype":"interrupt"}}`; received `{"type":"control_response","response":{"subtype":"success"}}`, then an error `result` with `terminal_reason:"aborted_tools"`. The same PID then returned `after-interrupt`. |
| `set_model` | Yes | Sent `{"type":"control_request","request":{"subtype":"set_model","model":"haiku"}}`; received success. The next assistant event reported `message.model:"claude-haiku-5-5"`. |
| MCP reconnect | Yes, automatic | Before restart, `spike_ping` returned `{"bootId":"3938a68e-f503-43fb-9901-c9efd8cac546","calls":1}`. After stop/start on 5199, without `mcp_status`, `mcp_reconnect`, or `--resume`, it returned `{"bootId":"77a7a648-051e-4fcb-8161-eec5bd8e7be2","calls":1}` on PID `76624`. |

Each sent object and the selected assistant, result, user replay, and control-response events are logged by the script. Per-turn cwd does not apply to Claude stream-json input: its cwd is fixed when the process starts. The run ended with `claude_exit {"code":143}` because the script intentionally terminates the persistent child in `finally`; it then logged `mcp_stopped` and `cleanup_complete`.
