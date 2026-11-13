# D-ASK agent-host protocol, version 1

The protocol between the .NET daemon (`src/DAsk.Daemon/AgentHost/AgentHostManager.cs`) and the stdio agent host (`agent/host/`). Implementation: [protocol.ts](../agent/host/protocol.ts).

## Transport

- JSON Lines over the host's inherited stdin and stdout. UTF-8, one JSON object per line, terminated by `\n` (`\r\n` accepted).
- **stdout carries protocol lines only.** At startup the host redirects `process.stdout.write` and `console.*` to stderr, so no library or tool can write to the stream. `JSON.stringify` escapes newlines, so model or tool text cannot break a line.
- **stderr carries diagnostics only.** It never contains objectives, tool inputs or credentials.
- The longest accepted input line is 64 KiB. A longer one gets `message_too_large` and is discarded. The next line works normally.

## Messages

```text
request   {"v":1,"id":"<id>","op":"<op>","params":{...}}
response  {"v":1,"kind":"response","id":"<id>","ok":true,"result":{...}}
          {"v":1,"kind":"response","id":"<id>"|null,"ok":false,"error":{"code":"...","message":"..."}}
event     {"v":1,"kind":"event","event":"task.progress"|"task.finished","requestId":"<submit id>","taskId":"...","seq":<n>,"data":{...}}
```

- `id` and `taskId` match `^[A-Za-z0-9_-]{1,64}$`.
- Every request gets exactly one response with its `id`. `id` is `null` only when the line could not yield a valid id (malformed JSON, oversized line, invalid id).
- Validation is strict. Unknown fields, parameters and operations are **rejected**, not ignored.
- Events carry the `requestId` of the submit that started the task. `seq` counts up from 1 for each task, without gaps.
- `task.progress` data for a plan holds `intent`, `goal`, `tools` and `stepIds`. Progress never holds tool inputs or raw outputs.

## Operations

| Op | Params | Result |
|---|---|---|
| `hello` | `token`, `emergencyStopped`, `stopGeneration` | Same as `health`. Must be the first request. |
| `health` | none | `protocol`, `pid`, `ready`, `shuttingDown`, `emergencyStopped`, `stopGeneration`, `activeTaskId`, `uptimeMs`, `rssMB`, `model` |
| `submit` | `taskId`, `objective` (at most 4,000 characters) | `accepted`, `taskId`. The task runs in the background. |
| `status` | `taskId` | `taskId`, `state` (`running`, `cancelling`, `finished`), `elapsedMs`, `result` |
| `cancel` | `taskId` | `taskId`, `cancelling`, `state` |
| `emergency_stop` | `generation` | `stopped`, `generation`, `abortedTasks` |
| `resume` | `generation` (must equal the current one) | `stopped`, `generation` |
| `shutdown` | none | `shuttingDown`. The host aborts work, stops the model and exits with code 0. |

There is deliberately no operation that names a tool, a permission or an approval.

## Task result (`task.finished` data, `status` result)

```json
{
  "taskId": "t1", "outcome": "completed", "response": "Done.\n• (17+25)*2 = 84",
  "iterations": 1, "toolCalls": 1, "error": null,
  "steps": [{ "id": "s1", "tool": "math.evaluate", "status": "succeeded", "evidence": "(17+25)*2 = 84", "error": null }],
  "verification": { "independentlyVerified": true, "criteriaSatisfied": true, "method": "evidence+model", "unexplained": [],
                    "facets": [{ "id": "math:(17+25)*2", "satisfied": true }], "grounding": [{ "stepId": "s1", "status": "grounded" }] }
}
```

`outcome` is exactly the runtime's: `completed`, `unverified`, `partial`, `failed`, `refused` or `cancelled`.

## Concurrency

Requests are handled in arrival order and answered immediately; long work reports through events. **One task runs at a time**, because there is one model slot. A second `submit` while one runs gets `busy`; it is not queued, and its task id stays unused. `health`, `status`, `cancel`, `emergency_stop` and `shutdown` are served while a task runs.

## Error codes

| Code | Meaning |
|---|---|
| `malformed_json` | The line is not JSON (`id` is null) |
| `message_too_large` | The line exceeds 64 KiB (`id` is null) |
| `invalid_request` | Not an object, a bad `id`, or an unknown top-level field |
| `unsupported_version` | `v` is not 1 |
| `unknown_op` | The operation does not exist |
| `invalid_params` | A missing, mistyped or unknown parameter |
| `not_authenticated` | Any request before a valid `hello` |
| `authentication_failed` | Wrong token. The host exits with code 3. |
| `already_authenticated` | A second `hello` |
| `duplicate_task` | The task id was already accepted. It never runs twice. |
| `busy` | Another task is running |
| `unknown_task` | No such task |
| `emergency_stopped` | New tasks are refused until a valid `resume` |
| `stale_generation` | `resume` with a generation other than the current one |
| `shutting_down` | The host is exiting |
| `internal_error` | Details go to stderr only |

## Host exit codes

| Code | Meaning |
|---|---|
| 0 | Clean shutdown, or stdin closed |
| 1 | Uncaught failure |
| 2 | Refused to start: no valid token, stdin is a terminal, `DASK_INFERENCE` is not `local`, or `DASK_ROOT` is unset |
| 3 | Wrong token presented |

## Named-pipe API (daemon to its clients)

The HUD talks to the daemon, not to the host. These messages use the existing length-prefixed pipe envelope, and only after the existing peer check and handshake. Definitions: [AgentTaskMessages.cs](../src/DAsk.Protocol/IPC/Messages/AgentTaskMessages.cs).

| Request | Response |
|---|---|
| `AgentTaskSubmitRequest` | `AgentTaskSubmitResponse` |
| `AgentTaskStatusRequest` | `AgentTaskStatusResponse` |
| `AgentTaskCancelRequest` | `AgentTaskCancelResponse` |
| `AgentHostHealthRequest` | `AgentHostHealthResponse` |

Notifications go only to the session that owns the task: `AgentTaskProgressNotification` and `AgentTaskResultNotification`. A task belonging to another session looks exactly like one that doesn't exist.

Submit rejection codes: `agent_host_disabled`, `host_unavailable`, `emergency_stopped`, `busy`, `invalid_request`, `daemon_model_busy`.

## HUD bridge (frontend to Rust host)

The frontend talks only to the Rust host. Implementation: [agent_bridge.rs](../src/hud-native/src/ipc/agent_bridge.rs), [nativeAgent.ts](../hooks/nativeAgent.ts).

| Frontend sends | Payload (any other field is rejected) | Becomes |
|---|---|---|
| `AgentTaskSubmit` | `request_id`, `objective` | `AgentTaskSubmitRequest`, with `request_id` as the envelope id |
| `AgentTaskCancel` | `request_id`, `task_id` | `AgentTaskCancelRequest` |

The frontend receives `AgentTaskSubmitResponse`, `AgentTaskCancelResponse`, `AgentTaskProgressNotification` and `AgentTaskResultNotification` as `{type, replyToId, payload}`, plus `AgentConnection` with `{connected, emergencyStopped}`.

- **Refused locally, never queued:** a submit during a latched Emergency Stop (`emergency_stopped`) or while disconnected (`daemon_unavailable`). A request created before the current pipe session was established fails instead of being sent.
- **Connection loss:** a running task ends in the HUD as interrupted with its result unknown. It is never resubmitted.
- **Browser:** without the Rust bridge, the page uses the HTTP transport (`/api/assistant`, `/api/tasks`) as before.

## Packaged installs

With `AgentHost:RequireVerifiedPackage` set, the daemon checks `package-manifest.json` against `AgentHost:ManifestSha256` and every listed file against the manifest before each host start, and refuses any unlisted file in `dist/agent-host`. Any difference fails the start with `host_unavailable`, and the cause goes to the daemon log. Development runs do not use this check.
