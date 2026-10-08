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

## Codex app-server 0.161.0

Run the Codex path from the routed Workbench worktree:

```sh
SPIKE_PROVIDER=codex npx tsx scripts/session-spike.ts
```

The checked run used Workbench managed command `persistent-sessions-codex-spike`, attempt 1, and exited 0 on 2026-10-08. It started one `codex app-server --stdio` PID, using `CODEX_APP_SERVER_ARGS`, `WORKBENCH_LOCAL_MCP_TOKEN=loopback`, and the throwaway `http://127.0.0.1:5199/mcp` URL. It sent `initialize` with the same client info and capabilities as `initializeCodexAppServer`, then `initialized`, then `thread/start` from `codexThreadBootstrapRequest` with only the MCP URL replaced. Port 5180 was not started or stopped.

| Check | Result | Observed excerpt |
| --- | --- | --- |
| Three turns on one thread | Yes | `turn/completed` returned `one`, `two`, and `three` for thread `01a11d55-75ba-7e90-a88e-c6906805e08c`. Each `ps -o pid,lstart` recorded `80590 Thu Oct 8 17:05:01 2026`. |
| Interrupt and next turn | Yes | After the first `agentMessage`, sent `{"jsonrpc":"2.0","id":7,"method":"turn/interrupt","params":{"threadId":"01a11d55-75ba-7e90-a88e-c6906805e08c","turnId":"01a11d55-9ad2-7ea1-9a83-bff9e9be180a"}}`. The completion status was `interrupted`; the next turn returned `after-interrupt` on PID 80590. |
| Per-turn model, effort, and cwd | Yes | Sent overrides `model:"gpt-6.1-sol", effort:"low", cwd:"…/one"` and then `model:"gpt-6.1-sol", effort:"high", cwd:"…/two"`. Tool output printed each matching cwd and its marker (`one`, then `two`). The session log recorded those same cwd, model, and effort values. |
| MCP restart | Yes, automatic | Before restart, `spike_ping` returned boot `f1000a27-ae4a-42f1-b258-b7656b4cf509`; after stopping and starting 5199, it returned `e9509ff5-3707-410a-8727-d6c63f398504` on PID 80590. No `mcpServerStatus/list`, `config/mcpServer/reload`, or fresh-process resume was needed. |

The managed output logs every JSON-RPC request as `sent`, plus `turn/started`, `item/completed`, `turn/completed`, and `ps` excerpts. The `finally` block closed the Codex child and the throwaway MCP server; the managed command exited 0 and a post-run `pgrep -af 'codex app-server'` returned no process.
