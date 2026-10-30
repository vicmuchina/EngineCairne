# Cairn Runtime v2 — pi event trace, activity feed, thin MainAgent, approvals

Status: backend vertical slice implemented and tested against a **copy** of the live DB on a
temp Uvicorn (`127.0.0.1:8012`). The live server/dispatcher were not restarted.

## What is in this round

| Area | Delivered |
| --- | --- |
| A. Rich pi ingestion | `chat_activities` table, live JSONL tailer, token usage per message/run, `GET /chat/conversations/{id}/activities`, stop/timeout marks the whole trace |
| B. Project feed | `GET /projects/{id}/activity` (facts/intents/hints/worker/steering/approval/chat), `GET /projects/{id}/overview`, activity writer + dispatcher hooks |
| C. Thin MainAgent | `cairn-control` MCP server (8 tools) registered **per chat session**, MainAgent system prompt, steering table + endpoints, dispatcher delivers at task boundaries, `intents.priority` |
| D. Approvals | `approval_requests` table + endpoints, approval-gated MainAgent actions, `cairn-approval` pi extension that blocks unapproved tool calls |

## Files

New:

- `src/cairn/server/activity.py` — chat activity recorder, project activity writer/feed, overview
- `src/cairn/server/routers/steering.py` — steering queue API
- `src/cairn/server/routers/approvals.py` — approval queue API (incl. long-poll)
- `src/cairn/control/client.py` — HTTP control client + approval gating for actions
- `src/cairn/control/mcp_server.py` — stdlib stdio MCP server (`python -m cairn.control.mcp_server`)
- `src/cairn/chat_extensions/cairn-control.js` — pi extension that registers the MCP server for this session only
- `src/cairn/chat_extensions/cairn-approval.js` — pi extension that blocks gated tool calls until approved
- `tests/test_runtime_v2.py` — 12 tests (ingestion, feed, steering, approvals, MCP, migrations)

Modified:

- `src/cairn/server/db.py` — new tables + idempotent `ALTER TABLE` migrations
- `src/cairn/server/chat_runtime.py` — JSONL tailer (live persistence), extension/env wiring, MainAgent prompt
- `src/cairn/server/routers/chat.py` — activities endpoint, token usage, stop/timeout/stale marking
- `src/cairn/server/routers/projects.py` — activity/overview/activity-writer endpoints, status events
- `src/cairn/server/routers/intents.py` — claim/release activity rows, `priority` on create
- `src/cairn/server/models.py`, `services.py` — new models, `Intent.priority`
- `src/cairn/server/app.py` — routers registered
- `src/cairn/dispatcher/protocol/client.py` — `pending_steering`, `deliver_steering`, `record_activity`
- `src/cairn/dispatcher/tasks/common.py`, `tasks/reason.py`, `tasks/explore.py` — steering fetch/inject/deliver
- `src/cairn/dispatcher/prompting.py`, `prompts/default/{reason,explore}.md` — `{steering}` block
- `src/cairn/dispatcher/scheduler/loop.py` — worker started/finished activity events, priority-aware intent pick
- `tests/conftest.py` — fake client steering/activity methods

## A. Rich pi event ingestion

`pi --mode json` writes one JSON object per line. The chat runtime still lets pi write to
`runs/chat/<id>/logs/<run>.jsonl`, and a tailer follows that file and persists each complete
line **while the turn is running** (100 ms poll). No content is synthesized: rows are 1:1 with
events pi emitted.

Table `chat_activities` (`conversation_id`, `message_id`, `run_id`, `seq`, `kind`, `role`,
`content`, `tool_name`, `tool_call_id`, `tool_input`, `tool_output`, `status`, `error`,
`tokens_in/out`, `created_at`, `raw_json`). `seq` is monotonic per conversation so the UI can
poll with `after_seq`.

Mapping (pi event → row):

| pi event | kind | notes |
| --- | --- | --- |
| `session` | `session` | pi session id |
| `agent_start`, `turn_start`, `turn_end`, `agent_end`, `agent_settled` | same | turn counter |
| `message_start` | `message` | user/system immediately `done`; assistant `streaming` |
| `message_update` (`text_delta`/`text_end`) | `message` | throttled updates (250 ms) + final text |
| `message_update` (`thinking_*`) | `thinking` | same throttling |
| `message_update` (`error`) | `error` | error text preserved |
| `message_end` | `message` + `usage` | final text, stopReason, `tokens_in/out` |
| `tool_execution_start` | `tool_call` | `status=running`, args in `tool_input` |
| `tool_execution_update` | `tool_call` | partial output (throttled) |
| `tool_execution_end` | `tool_call` | `done`/`error`, output, duration |
| `compaction_start/end` | `compaction` | |
| `auto_retry_*`, `summarization_retry_*` | `retry` | |
| `queue_update` | `queue` | |
| `entry_appended`, `session_info_changed`, `thinking_level_changed` | `session_entry`/… | pi bookkeeping |
| anything else | `event` | stored verbatim; nothing dropped |

Usage: each assistant message's `usage.input/output` is summed into `chat_messages.tokens_in/out`
and `chat_runs.tokens_in/out` (plus `turns`, `tool_calls`, `model`). `GET /chat/conversations/{id}`
returns `tokens_in`, `tokens_out`, `activity_count`; messages return their own token counts.

Stop/timeout: `ChatActivityRecorder.finish(status, error)` closes every `running`/`streaming` row
as `stopped` or `error` (with the same error text), and the stale-run reconciler does the same for
rows left behind by a dead process.

```
GET /chat/conversations/4/activities?after_seq=0&limit=200[&run_id=…][&kind=tool_call,error][&include_raw=1]
→ {"items":[{"id":12,"conversation_id":4,"message_id":9,"run_id":"…","seq":7,"kind":"tool_call",
             "role":"assistant","tool_name":"read","tool_call_id":"call_1",
             "tool_input":"{\"path\":\"x\"}","tool_output":"file body","status":"done",
             "error":null,"tokens_in":null,"tokens_out":null,"created_at":"…"}],
   "next_after_seq":12,"has_more":false,"conversation_id":4}
```

## B. Project activity feed + overview

`GET /projects/{id}/activity?after=<cursor>&limit=50&kinds=intent,tool`

Unified chronological feed merging:

- facts (kind `goal`/`fact`) — **no created_at in the schema**, so the timestamp is derived from
  the producing intent's `concluded_at`; with no producing intent (`origin`) it is `null` and
  `timestamp_source="unknown"` (never invented)
- intents (`intent`) — `created_at`, status `open`/`working`/`concluded`
- hints (`hint`)
- `project_activity` rows — `project`, `status`, `worker`, `steering`, `approval`
- chat activities — `tool`, `chat`, `error`, `compaction` (assistant/user messages only)

Items: `{kind, id, project_id, timestamp, timestamp_source, actor, status, title, description,
metadata, source, cursor}`. Ordering is `(timestamp, id)`; unknown timestamps sort last.
`next_cursor` is emitted for the last item with a known timestamp (opaque `"<ts>#<id>"`).

```
GET /projects/proj_004/activity?limit=2
{"items":[{"kind":"intent","id":"intent:i001","timestamp":"2026-10-24T12:40:32Z",
           "timestamp_source":"intent.created_at","actor":null,"status":"concluded", …}],
 "next_cursor":"2026-10-24T12:45:43Z#fact:f001","has_more":true,"project_id":"proj_004"}
```

`GET /projects/{id}/overview` returns `project`, `generated_at`, `counts` (facts, intents,
open/working/unclaimed/concluded, hints, pending_steering, pending_approvals, chat_conversations,
chat_activities, tool_calls, tokens_in/out), `workers` (current claims), `recent_activity` (10).
Every number comes from the DB.

`POST /projects/{id}/activity` is the writer used by the dispatcher:
`{kind, title, description, actor, status, metadata, source}`.

## C. Thin MainAgent

**Control MCP server** — `python -m cairn.control.mcp_server` (stdlib, JSON-RPC over stdio).
Registered for the chat session only by `chat_extensions/cairn-control.js` via
`pi.registerMcpServer("cairn-control", {...})`; nothing is written to `~/.pi/agent/mcp.json`.
Exposure is `direct`, so the model gets the tools as `mcp__cairn_control__<tool>`.

Tools: `graph_overview`, `list_activity`, `add_hint`, `add_intent`, `set_project_status`,
`steer_intent`, `request_approval`, `check_approval`.

**System prompt** (`chat_runtime.MAIN_AGENT_RULES`) tells the MainAgent to observe first, steer via
the tools, never invent findings/counts, never run the research itself, and to report
`pending approval` honestly. The prompt also lists graph counts, pending steering and pending
approvals.

**Steering queue**

```
POST /projects/{id}/steering {"intent_id":"i061","message":"…","created_by":"mainagent"}
GET  /projects/{id}/steering?pending=1[&intent_id=i061|&project_only=1]
POST /projects/{id}/steering/{sid}/delivered {"worker":"…","run":"…"}
DELETE /projects/{id}/steering/{sid}
```

Dispatcher: `reason` reads **project-level** steering (`intent_id IS NULL`); `explore` reads
project-level plus steering for its own intent. The text is rendered into the worker prompt
(`{steering}` block in `reason.md`/`explore.md`) and the rows are marked `delivered` **after the
worker process ran** with that prompt (at-least-once; a crash re-delivers).

`priority` (intents): new nullable column with `DEFAULT 0`; dispatcher picks
`max(unclaimed, key=(priority, created_at))`, identical behaviour when every priority is 0.

## D. Approvals

```
POST /projects/{id}/approvals {action, payload, requested_by, conversation_id?, note?, expires_in?}
GET  /projects/{id}/approvals?status=pending
GET  /approvals?status=pending                    # cross-project queue for the UI tab
GET  /approvals/{id}?wait=30                      # async long-poll while pending
POST /approvals/{id}/approve {decided_by, note?}
POST /approvals/{id}/deny    {decided_by, note?}
```

Rules: non-pending decisions → 409; expired requests are marked `expired` on read and cannot be
approved; every transition writes a `project_activity` row.

**Enforcement point 1 — MainAgent actions.** `CAIRN_APPROVAL_ACTIONS=add_hint,add_intent,…` makes
the control client create an approval, long-poll the decision, and only then call the REST action.
Any status other than `approved` returns `{"executed": false, "status": "pending|denied|expired"}`
and the action is not sent.

**Enforcement point 2 — pi tool calls.** `CAIRN_CHAT_APPROVAL_TOOLS=bash,write,edit` enables
`cairn-approval.js` for the chat session; it hooks pi's `tool_call` event, creates an approval,
waits for the decision and returns `{block:true}` unless approved. pi records the block as an error
tool result, which lands in `chat_activities` as a `tool_call` row with `status="error"` and the
"not approved" text. Fail-closed: an unreachable approval service blocks the tool.

Both are **off by default**, so restarting the live server does not change current chat behaviour
except for the additive control tools.

## Configuration (server env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAIRN_CHAT_CONTROL` | `1` | load `cairn-control.js` for chat sessions (`0` disables) |
| `CAIRN_CONTROL_URL` | `http://127.0.0.1:8000` | Cairn API the control server/MCP talk to |
| `CAIRN_CONTROL_PYTHON` | server `sys.executable` | interpreter used for the stdio MCP server |
| `CAIRN_APPROVAL_ACTIONS` | empty | control actions that require approval |
| `CAIRN_APPROVAL_WAIT` | `90` (MCP) / `30` (pi ext) | seconds per long-poll |
| `CAIRN_CHAT_APPROVAL_TOOLS` | empty | pi tool patterns to gate (`bash`, `write*`, …) |
| `CAIRN_APPROVAL_TIMEOUT` | `180` | total seconds the pi extension waits |

## Test evidence

`pytest` (in-process ASGI + stub pi): **114 passed**, 1 pre-existing unrelated failure
(`test_local_execution.py::test_shipped_local_example_config_is_valid` — the symlinked
`dispatch.local.example.yaml` path does not exist; it failed the same way before this work).

Temp server (`127.0.0.1:8012`, DB copied with `sqlite3 .backup` from the live DB):

- migrations applied to the copy (new tables + `intents.priority`), live DB untouched
- `overview` on `proj_004`: `facts=63 intents=63 open=2 concluded=61`
- feed pagination + cursor: page 1 `intent:i001…i005`, page 2 starts at `fact:f004`, no duplicates
- steering `201 pending` → `pending=1` → delivered (`delivered_to=test-worker`)
- approvals `201 pending` → `approved` → re-decide `409` → `denied`, feed shows all four transitions
- MCP stdio: `initialize` → `tools/list` (8 tools) → `graph_overview` (63 facts) → `steer_intent`
- approval-gated MCP action: no decision → `executed=false`, hint count unchanged; approved while
  waiting → `executed=true`, hint created
- **real pi turn** (`CAIRN_CHAT_OK`): reply `CAIRN_CHAT_OK`, `tokens_in=29339 tokens_out=7`, 12
  activities (`session … agent_settled`)
- **real pi turn with the control tool**: model called `mcp__cairn_control__graph_overview` and
  answered "63" (fact count) / `i061, i063` (open intents); the tool call is in `chat_activities`
- **real pi tool-call approval gate**: `CAIRN_APPROVAL_TOOLS=bash`; without approval pi reported
  `Tool call "bash" was not approved: approval #5 is pending` and the command did **not** run; with
  an approver the same call executed (`isError=false`, marker file created)

## Gaps / not claimed

- **Live mid-turn steering is not implemented.** `pi --mode json -p` is one-shot (stdin is closed;
  no injection channel), and dispatcher workers are one-shot container processes. Steering is
  therefore delivered at task boundaries only. The real path is pi **RPC mode**
  (`pi --mode rpc`, persistent process) and `{"type":"steer","message":…,"streamingBehavior":"steer"}`,
  which pi delivers after the current turn's tool calls and before the next model call; that needs
  a persistent per-worker process manager (chat and dispatcher), which is the next round.
- Approvals for dispatcher-worker tool calls are not wired (workers run in containers with their
  own pi invocation); only chat tool calls and MainAgent actions are gated.
- `chat_extensions/*.js` are resolved from the source tree; a non-editable wheel build would need
  package-data config (the chat degrades gracefully: no control tools, chat still works).
- Feed/overview merge rows in Python; fine for current graph sizes, would need SQL UNION +
  indexes at 10k+ intents.
- The Artex UI is not touched this round (next round wires the tabs to these endpoints).

## Live restart (not run)

```
cd /home/vic/.local/share/artex-tools/cairn/cairn && .venv/bin/cairn serve --host 127.0.0.1 --port 8000 --db-path /home/vic/.local/share/artex-tools/cairn/data/cairn.db --no-access-log
```

(Stop the existing `cairn serve` PID first; migrations are idempotent and run on startup. The
dispatcher can be restarted with its existing line afterwards to pick up steering delivery.)
