# Cairn Runtime v3 — contained MainAgent, honest approvals, exact paging, persistent pi RPC

Status: implemented and tested against a **copy** of the live DB on temp Uvicorn servers
(`127.0.0.1:8016` RPC mode, `127.0.0.1:8017` json mode). The live server (`:8000`) and the
dispatcher were **not** restarted, stopped or migrated; no live row was written.

This round fixes the v2 runtime critic's P0/P1 defects and adds the missing live mid-turn
steering path for chat (P2).

---

## 1. What changed

| Priority | Item | Delivered |
| --- | --- | --- |
| P0 | MainAgent tool surface | default is now `--no-builtin-tools --tools mcp__cairn_control__*`; `bash/read/write/edit` require `CAIRN_CHAT_TOOLS` opt-in |
| P0 | Delimiter escaping | `<project_data>`-like tags neutralized in every untrusted value; worker prompts carry a data-trust section; prompt rendering is single-pass |
| P0 | Project binding | control MCP write tools no longer accept `project_id`; the client rejects cross-project reads/writes before HTTP; path segments are percent-encoded; approvals are bound-checked |
| P1 | Atomic approvals | `UPDATE ... WHERE status='pending' RETURNING *`, 409 for losers, activity written only by the winner; bulk expiry on every read path |
| P1 | REST boundary | explicitly **advisory** + execution-layer enforcement, `action_hash` binding, single-use `consume`, machine-readable `GET /approvals/policy` |
| P1 | feed/overview | overview returns the newest N; every row has a cursor (`~#id` when untimestamped); same-second rows no longer skipped; `kinds` filtered in SQL before `LIMIT` |
| P1 | tailer/orphans | one incremental UTF-8 decoder + LF-only framing + sidecar offset; cancellation kills the process group; startup sweep verifies `/proc/<pid>/cmdline` before killing and replays the remaining JSONL |
| P1 | steering/priority | worker steering marked delivered only when the worker process accepted the prompt; intents picked by `(priority DESC, created_at ASC, id ASC)` |
| P2 | live chat steering | persistent `pi --mode rpc` session per conversation, `POST /chat/conversations/{id}/steer`, steering activity, idle cap, one process per conversation |

---

## 2. Files

New:

- `src/cairn/server/pi_rpc.py` — `PiRpcSession` (LF JSONL protocol, id correlation, extension
  UI auto-cancel, settled/abort handling) and `ChatSessionManager` (warm sessions, idle cap,
  LRU cap, crash recovery, per-conversation locks, shutdown, project-scoped close)
- `tests/test_runtime_v3.py` — 47 tests for every P0/P1/P2 item
- `tests/fake_pi_rpc.py` — fake `pi --mode rpc` server used by the tests (normal, slow/steerable,
  no-settle, crash, garbage stdout, flood, late-events, stale-queue modes)
- `RUNTIME-V3.md` (this file)

Modified:

- `src/cairn/server/chat_runtime.py` — default-deny tool args, delimiter escaping,
  incremental-decoder tailer + sidecar offsets, `CancelledError` handling, `reap_stale_runs`,
  `replay_jsonl`, `build_rpc_argv`, `execute_rpc_turn`, RPC-aware `stop_run`/`shutdown_all`
- `src/cairn/server/activity.py` — `feed_event`, steering/raw/notify rows, `expire_pending_approvals`,
  cursor sentinel + id-aware sort key, SQL kind filters, exact `(created_at, id)` tie-break,
  newest-first overview
- `src/cairn/server/routers/chat.py` — RPC turn execution, `POST /steer`, cancellation finalize,
  `mode` on stop, RPC session close on delete
- `src/cairn/server/routers/approvals.py` — atomic decide, consume, policy, bulk expiry
- `src/cairn/server/routers/projects.py` — async project delete that closes warm sessions
- `src/cairn/server/routers/steering.py` — docstring now distinguishes boundary vs live steering
- `src/cairn/server/models.py` — `ApprovalItem.action_hash/consumed_at/consumed_by`,
  `ApprovalConsumeRequest`, `ApprovalPolicy`, `ProjectOverview.recent_activity_order`
- `src/cairn/server/db.py` — `chat_runs.log_path/log_offset/mode`,
  `approval_requests.action_hash/consumed_at/consumed_by`, pending-expiry index (idempotent)
- `src/cairn/server/app.py` — startup stale-run sweep, RPC reaper, multi-worker warning
- `src/cairn/control/client.py` — project binding, URL encoding, action hash, consume,
  approval bound checks
- `src/cairn/control/mcp_server.py` — no `project_id` on write tools, binding instructions
- `src/cairn/dispatcher/prompting.py` — single-pass `render_prompt`, delimiter escaping,
  steering sanitization, `UNTRUSTED_DATA_NOTE`
- `src/cairn/dispatcher/prompts/default/{reason,explore}.md` — data-trust section
- `src/cairn/dispatcher/tasks/common.py` — `worker_accepted_prompt`, acceptance-gated
  `mark_steering_delivered`
- `src/cairn/dispatcher/tasks/{reason,explore}.py` — pass acceptance
- `src/cairn/dispatcher/scheduler/worker_select.py`, `scheduler/loop.py` — `select_unclaimed_intent`
- `tests/test_chat_api.py`, `tests/test_runtime_v2.py` — fixtures pin `CAIRN_CHAT_RPC=0`
  (those modules test the one-shot json path)

---

## 3. P0 — contained MainAgent

> **v3.1 note.** The critic found that chat pi ran in the *worker* workspace
> (`runs/<project>`) and therefore loaded worker-writable `AGENTS.md`/skills. v3.1 moves chat
> to `runs/chat/<conversation id>`, adds
> `--no-context-files --no-skills --no-prompt-templates --no-themes` and a per-session
> `PI_CODING_AGENT_DIR` with only auth/model config. Details and live evidence:
> `RUNTIME-V3.1.md` §1. Everything below stays valid but is no longer sufficient on its own.

### 3.1 Tools are denied by default

`chat_runtime.chat_tool_args()`:

| `CAIRN_CHAT_TOOLS` | argv |
| --- | --- |
| unset / empty | `--no-builtin-tools --tools mcp__cairn_control__*` |
| `mcp__cairn_control__*` | `--no-builtin-tools --tools mcp__cairn_control__*` |
| `bash,read` (explicit opt-in) | `--tools bash,read` |
| `none` / `off` | `--no-tools` |

v2 passed no tool flags at all when `CAIRN_CHAT_TOOLS` was unset, so pi's default built-ins
plus every MCP server on the host were reachable from the chat MainAgent. Nothing is
re-added silently: a value containing built-ins is treated as the explicit allowlist it is.

Live confirmation (real pi, temp server): the only tool the model could call was
`mcp__cairn_control__graph_overview`; it answered "63 facts and 2 open intents (i061, i063)".

### 3.2 Delimiter escaping and untrusted-data warnings

- `chat_runtime.escape_delimiters()` entity-escapes the leading `<` of
  `project_data|system|instructions|operator_steering|untrusted_data|graph` open/close tags.
  It is applied to fact ids/descriptions, intent ids/descriptions, hint ids/creators/content,
  pending steering, pending approval fields, project title/status and the goal.
- `dispatcher.prompting.format_steering()` escapes the same tags, flattens newlines and
  escapes author/target, so one steering row cannot forge a second bullet.
- `reason.md` and `explore.md` now carry a `## Data trust boundary` section declaring the
  graph YAML / facts / intents / hints / steering untrusted data (prompt-injection aware).
- `render_prompt()` is single-pass over the *template*: untrusted data containing
  `{max_intents}` is no longer re-substituted by a later replacement (v2's sequential
  `str.replace` re-scanned its own output).

### 3.3 Control tools are bound to the conversation project

- Write tools (`add_hint`, `add_intent`, `set_project_status`, `steer_intent`,
  `request_approval`) no longer expose `project_id` at all.
- `ControlClient._project()` returns the bound project and raises for any other value, so a
  hidden/extra argument cannot cross projects. Bound also applies to `graph_overview`,
  `list_activity` and `check_approval` (approval rows from another project are rejected).
- Every path segment is `urllib.parse.quote(..., safe="")`.
- The chat process env carries `CAIRN_CONTROL_PROJECT` and `CAIRN_CHAT_BOUND_PROJECT`.

### 3.4 Transport trust

Cairn assumes the HTTP API is bound to `127.0.0.1` with no authentication. That is unchanged
and now stated explicitly in the approvals policy document, in the client module docstring
and here. Approvals are not an authentication mechanism; see §4.3.

---

## 4. P1 — approvals

### 4.1 Atomic decision

```python
UPDATE approval_requests
SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
WHERE id = ? AND status = 'pending'
RETURNING *
```

No row → the loser re-reads and gets **409**. The `project_activity` row is written only by
the winning transaction (inside the same SQLite transaction).

Evidence: 20 concurrent approve/deny calls (in-process ASGI) and 16 over live HTTP →
exactly one `200`, the rest `409`, and exactly one decision activity.

### 4.2 Expiry is applied on read

`activity.expire_pending_approvals()` makes the transition with
`WHERE status='pending' AND substr(expires_at,1,19) <= <now>` (second-prefix comparison so
legacy rows without microseconds expire consistently), writes one `expired` activity per
winning row, and runs from:

- `GET /projects/{id}/approvals`, `GET /approvals`, `GET /approvals/{id}`
- `GET /projects/{id}/overview` (so `counts.pending_approvals` is honest)
- `POST /approvals/{id}/{approve,deny,consume}`
- `chat_runtime.build_system_context()` (the MainAgent never sees a dead approval as pending)

### 4.3 The REST boundary (decided, documented, enforced where it can be)

> **v3.1 note.** This section described v3's policy, which claimed `execution-layer`
> enforcement even when the gate set was empty. v3.1 computes the policy from the live
> configuration (`gate_active`, `gated_actions`, `gated_chat_tools`), makes the default gate
> the MainAgent writes, requires `action_hash` on consume and fails closed on missing hashes.
> See `RUNTIME-V3.1.md` §4. The shape below is v3.1's.

`GET /approvals/policy` returns:

```json
{"rest_boundary":"advisory","enforcement":"execution-layer",
 "enforced_by":["cairn.control.client.run_action (MainAgent actions)",
                "chat_extensions/cairn-approval.js (pi tool calls in chat)"],
 "gate_active":true,
 "gated_actions":["add_hint","add_intent","set_project_status","steer_intent"],
 "gated_chat_tools":[],
 "single_use":true,"action_binding":"sha256(action+payload), re-verified and consumed before execution",
 "tool_approvals":"chat pi sessions only (fail-closed, consume-before-execute); dispatcher workers are not gated",
 "worker_approvals":"not implemented: dispatcher workers run with --no-extensions",
 "transport_trust":"localhost, unauthenticated","notes":[...]}
```

With no gate configured the same endpoint returns `"enforcement":"none"`, `"gate_active":
false` and an empty `enforced_by` — it never overclaims.

The REST API is **not** gated — anyone who can reach the port can write to the graph. What is
enforced, at the execution layers:

1. `run_action()` validates the project binding, queues an approval carrying
   `action_hash = sha256(action+payload)`, waits for `approved`, **re-verifies the stored
   hash** (a missing hash is refused as `unbound`), then calls
   `POST /approvals/{id}/consume` with that hash (single use: a 409 means "already used" and
   the action does not run), and only then performs the write.
2. `cairn-approval.js` blocks a gated chat tool unless the approval is `approved` **and**
   bound to this exact tool call, and it consumes the approval *before* allowing the tool; an
   unreachable approval service blocks the tool (fail-closed).

### 4.4 Worker/container approvals are not implemented

Dispatcher workers run `pi ... --no-extensions` (`PiDriver._wrap_with_models`). The exact
wiring to add them is recorded in the policy `notes`:

- mount `chat_extensions/cairn-approval.js` into the worker image,
- add `--extension <path>` in `PiDriver._wrap_with_models`,
- put `CAIRN_APPROVAL_URL / CAIRN_APPROVAL_PROJECT / CAIRN_APPROVAL_TOOLS` into the worker
  env,
- use the same `action_hash` + `consume` contract for the `tool_call` action.

---

## 5. P1 — feed / overview

- **`/overview` returns the newest N.** `recent_activity` is descending
  (`recent_activity_order: "newest_first"`); untimestamped rows only fill the remainder.
  v2 returned the *oldest* 10.
- **Null-timestamp cursors.** Every item carries a cursor: `"<ts>#<id>"` or `"~#<id>"`.
  `has_more=true` always has a non-null `next_cursor`; paging to exhaustion reaches every row
  (verified on the copied live project: 21 pages, 144 unique items, 0 duplicates, 0 missing,
  `~#fact:goal` / `~#fact:origin` at the end).
- **Same-second rows are no longer skipped.** v2's SQL used `created_at > cursor_ts`, so rows
  sharing the cursor's second (very common: second-resolution timestamps) were dropped. The
  query is now `created_at > ? OR (created_at = ? AND id > ?)` after the in-memory total
  order, which is exactly `(timestamp, id)`.
- **`kinds` is applied in SQL before the limit** (`kind IN (...)`, chat kinds mapped
  `tool→tool_call`, `chat→message`, `steering→steering`, ...). A narrow filter cannot be
  starved by unrelated rows.
- **Ordering is numeric-aware**: `event:9` sorts before `event:10` (v2 compared id strings,
  so "newest 10" could be wrong when timestamps tied).
- Counts and `timestamp_source` are unchanged: facts still report
  `timestamp_source="intent.concluded_at"`, or `"unknown"` when no intent records one.

---

## 6. P1 — tailer, cancellation, orphans

### 6.1 Decoding and framing

`chat_runtime.JsonlTailer` uses **one incremental UTF-8 decoder** for the byte stream and
splits records on **LF only**:

```python
self._buffer += decoder.decode(chunk)      # a chunk may end mid-character
while "\n" in self._buffer: ...            # LF is the only record boundary
```

v2 decoded every read chunk independently (`chunk.decode("utf-8", errors="replace")`), which
turned a split multi-byte character into `U+FFFD`. Tests cover a payload split inside `é` and
a `U+2028`/`U+2029` inside a JSON string.

The byte offset is persisted after every batch to an atomic sidecar file
(`<run>.jsonl.offset`) plus `chat_runs.log_offset`, so a restart resumes exactly where the
tailer stopped instead of replaying (duplicating) the file.

> **v3.1 note.** v3 persisted the *read* offset, so a split trailing line was skipped on
> replay. v3.1 persists the **committed** offset (end of the last LF-terminated record) and
> re-reads the trailing partial bytes; see `RUNTIME-V3.1.md` §5.

### 6.2 Cancellation kills the group

- `execute_turn()` catches `asyncio.CancelledError`, sets `stop_requested`, and
  `asyncio.shield(_terminate_group(proc))` (SIGTERM to the process group → 5 s grace → SIGKILL).
- `send_message()` catches the same `CancelledError`, finalizes the turn synchronously
  (`_finalize_turn`, no `await` points, so it cannot be interrupted) with
  `status=stopped`, then re-raises.
- `stop`, timeout and app shutdown all go through the same process-group termination.
- RPC mode: cancellation sends `abort` and keeps the warm session (its history is the
  conversation).

### 6.3 Startup sweep

`chat_runtime.reap_stale_runs()` runs in the app lifespan before serving:

1. every `chat_runs` row still `running` has its PID checked for **process identity** before
   any signal: pi basename *and* a per-run token (`--session-id`/`--session` in argv, or —
   because real pi scrubs its argv via `process.title` — `CAIRN_CONTROL_CONVERSATION` /
   `PI_CODING_AGENT_DIR` in `/proc/<pid>/environ`) *and* the recorded start time
   (`chat_runs.pid_start_ticks`). A recycled PID, another chat, the user's interactive pi or
   a dispatcher/B44 worker is refused and logged, never signalled (v3.1; see
   `RUNTIME-V3.1.md` §3).
2. the remaining JSONL is replayed from `max(chat_runs.log_offset, sidecar)`,
3. the run closes as `stopped`, in-flight messages/activities become `stopped`, the
   conversation returns to `idle`.

Live evidence (temp server on a copied DB): a json-mode turn was started, the server was
`SIGKILL`ed, and the pi child survived (`orphan alive: True`, PID 229329). On restart:

```
reaped stale chat runs runs=1 killed_pids=[229329] replayed_lines=52 skipped_recycled_pids=[]
```

with `chat_runs.status=stopped`, `chat_conversations.status=idle` and the replayed trace in
`chat_activities`. The unit test also proves a non-pi PID (`sleep 120`) is reported in
`skipped_recycled_pids` and left running.

---

## 7. P1 — steering and priority

- **Delivery is acceptance-gated.** `worker_accepted_prompt(result)` is false for a spawn
  failure (126/127 from the `sh -lc` wrapper) or when the process produced no output at all.
  `mark_steering_delivered(..., accepted=...)` then keeps the row `pending` for the next task
  (at-least-once) instead of claiming delivery. Tests: reason task with `ProcessResult(127,"","")`
  → nothing marked.
- **Chat steering is acceptance-gated too.** The activity row is written only after pi
  answered `{"type":"response","command":"steer","success":true}` (see §8.4). An idle
  conversation returns 409: pi would otherwise queue the message for the *next* prompt —
  a stale instruction the user believes was dropped.
- **Stale queue drop.** At the start of every RPC turn the session sends `clear_queue`; any
  message pi still had queued (a steer that raced with turn completion) is recorded as
  `kind=steering, status=dropped` and never leaks into the new prompt.
- **Priority tiebreak.** `select_unclaimed_intent()` orders by
  `(-priority, created_at, id)`; v2 used `max(key=(priority, created_at))` (newest first, id
  ignored).

---

## 8. P2 — persistent pi RPC chat sessions

### 8.1 Process model

- One `pi --mode rpc` process per conversation, `stdin/stdout=PIPE`,
  `stderr=<runs/chat/<id>/logs/rpc-*.stderr.log>`, `start_new_session=True`.
- argv = `pi --session-id <id> --session-dir <dir> --extension cairn-control.js
  [--extension cairn-approval.js] <tool args> --mode rpc --append-system-prompt <ctx>`.
- `--workers 1` is required (the manager and the live-turn registry are per-process);
  `app.py` logs a warning when `CAIRN_SERVER_WORKERS`/`WEB_CONCURRENCY` > 1.
- Idle cap `CAIRN_CHAT_RPC_IDLE_SECONDS` (default 900 s) and LRU cap
  `CAIRN_CHAT_RPC_MAX_SESSIONS` (default 8) close warm sessions; the next turn restarts the
  process with the same `--session-id`, so pi replays its on-disk session history.
- `CAIRN_CHAT_RPC=0` keeps the v2 one-shot `--mode json -p` path (`stop`/`steer` behave as
  before; the steer endpoint returns 409).

### 8.2 Protocol rules implemented

| Rule | Implementation |
| --- | --- |
| LF framing, UTF-8 | binary reader, incremental decoder, `rstrip("\r")` for CRLF |
| command/response correlation | unique id per command, `dict[id, Future]`, late responses kept in a bounded `orphan_responses` list for diagnostics |
| event stream | every non-`response` record is forwarded to the active `ChatActivityRecorder` (`feed_event`) |
| extension UI | `select/confirm/input/editor` answered with `{"cancelled": true}`; `notify` recorded, status/widget plumbing ignored |
| turn completion | `agent_settled` only; `agent_end` never completes a turn (tested with a stub that emits `agent_end` and no settle → turn times out) |
| abort | `clear_queue` then `abort`, plus `agent_settled{aborted}` / `get_state.isStreaming` polling; `_abort_sent` is never cleared by a settle (v3.1) |
| continuation | commands `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_last_assistant_text`, `clear_queue` |

### 8.3 Context freshness

The `<project_data>` snapshot is taken when the **process starts** and passed with
`--append-system-prompt` (system prompts cannot be changed on a live RPC session). This is
intentional for a thin MainAgent: the rules tell the model to read live state through
`graph_overview`/`list_activity`. If the process is reaped or crashes, the next turn respawns
it with a fresh snapshot while keeping the session id (history preserved).

### 8.4 Steering endpoint

```
POST /chat/conversations/{id}/steer   {"message": "..."}
→ 200 {"accepted": true, "conversation_id": 5, "run_id": "…", "disposition": "queued",
       "activity_id": 125, "detail": "queued for delivery before the next model call"}
→ 409 {"detail": "Conversation has no running turn to steer"}
→ 409 {"detail": "Live steering needs pi RPC mode (CAIRN_CHAT_RPC=1); …"}
```

pi semantics: the message is delivered after the current assistant turn finishes its tool
calls and before the next model call.

### 8.5 Stop/abort semantics (v3.1)

```
POST /chat/conversations/{id}/stop
→ 200 {"stopped": true,  "reconciled": false, "detail": "turn aborted and persisted as stopped", …}
→ 200 {"stopped": false, "reconciled": false, "detail": "…has not finished yet…", …}  # honest
→ 200 {"stopped": false, "reconciled": true,  "detail": "No live pi process: … reconciled …"}
```

* `stopped:true` is only returned after `ChatRun.finished` (run/messages/activities
  persisted); a signalled-but-unfinished stop is `stopped:false`.
* The flag is set before the prompt is sent (a stop during session start-up never reaches
  pi), and re-checked immediately after prompt acceptance (abort instead of a normal run).
* `abort` is preceded by `clear_queue`, so queued steering/follow-up cannot continue the
  aborted turn.
* An aborted turn is `stopped` everywhere (message, run, conversation `idle`, activities,
  `agent_settled{aborted}`); the streamed partial text is kept. No synthetic `error` rows.

### 8.6 Dispatcher RPC (phase 2 — design only, not implemented)

Not implemented this round; workers remain one-shot. The design that fits the current code:

- **Process**: one `pi --mode rpc` process per `(project, worker, intent)` task, started by
  `LocalBackend`/`ContainerManager` the same way `build_exec_process` starts today
  (`start_new_session=True`, stderr to the task log), with the worker's `--tools`/`--no-extensions`
  flags unchanged and `--session-id` equal to the task session that `prepare_session()`
  returns. Container mode: `docker exec -i` with stdin kept open (`ManagedProcess.start()`
  currently passes `stdin=False`; that must become a writable stdin pipe).
- **Prompt**: `{"type":"prompt","message":<rendered prompt>}`; completion on `agent_settled`
  (not `agent_end`), then the existing JSON payload parsing runs on the accumulated text.
- **Steering poll**: the task runner polls `GET /projects/{id}/steering?pending=1&intent_id=…`
  every `runtime.interval/2` while the process runs, and for each new row sends
  `{"type":"steer","message":…}`; the row is marked delivered only after the successful
  steer response (same acceptance rule as today).
- **Risks**: (1) heartbeats and timeouts assume a short-lived process — a persistent worker
  needs its own idle timeout and orphan sweep (`/proc/<pid>/cmdline` + session dir);
  (2) container stdin multiplexing (docker exec) is easy to deadlock — a dedicated reader
  thread per stream is needed; (3) a mid-turn steer changes model output *while* the JSON
  contract is expected, so worker prompts must tolerate an interrupted answer;
  (4) process reuse across intents would leak context between tasks — keep one process per
  task; (5) `--no-extensions` must stay for workers until worker approvals exist (§4.4).

---

## 9. API examples

```bash
# --- P2: live mid-turn steer -------------------------------------------------
curl -s -X POST localhost:8000/chat/conversations/5/messages \
  -H 'content-type: application/json' \
  -d '{"message":"Write the numbers 1 through 400, one per line."}' &

curl -s -X POST localhost:8000/chat/conversations/5/steer \
  -H 'content-type: application/json' \
  -d '{"message":"STOP and reply with exactly: CAIRN_STEER_OK"}'
# {"accepted":true,"conversation_id":5,"run_id":"…","disposition":"queued","activity_id":125,…}

curl -s "localhost:8000/chat/conversations/5/activities?kind=steering"
# {"items":[{"kind":"steering","content":"STOP and reply with exactly: CAIRN_STEER_OK",
#            "status":"queued", …}], …}

# --- P1: feed paging to exhaustion ------------------------------------------
curl -s "localhost:8000/projects/proj_004/activity?limit=7"
# {"items":[{"id":"event:1",…,"cursor":"2026-10-29T23:06:13Z#event:1"}, …],
#  "next_cursor":"2026-10-29T23:06:13Z#event:7","has_more":true}
curl -s "localhost:8000/projects/proj_004/activity?limit=7&after=2026-10-29T23:06:13Z%23event:7"
# … ending with {"id":"fact:origin","timestamp":null,"cursor":"~#fact:origin"}

# --- P1: overview is newest-first -------------------------------------------
curl -s localhost:8000/projects/proj_004/overview | jq '.recent_activity_order, .recent_activity[0].title'
# "newest_first"
# "Chat steering"

# --- P1: approvals -----------------------------------------------------------
curl -s -X POST localhost:8000/projects/proj_004/approvals \
  -H 'content-type: application/json' \
  -d '{"action":"add_hint","payload":{"content":"x"},"requested_by":"mainagent","action_hash":"<sha256>"}'
curl -s -X POST localhost:8000/approvals/1/approve -H 'content-type: application/json' -d '{"decided_by":"vic"}'
curl -s -X POST localhost:8000/approvals/1/approve -H 'content-type: application/json' -d '{"decided_by":"vic"}'
# 409 {"detail":"Approval is already approved"}
curl -s -X POST localhost:8000/approvals/1/consume -d '{}' -H 'content-type: application/json'
# {"…","consumed_at":"…"}     # second call → 409
curl -s localhost:8000/approvals/policy | jq '.rest_boundary, .enforcement'
# "advisory" / "execution-layer"
```

---

## 10. Test evidence

> **v3.1 note.** The numbers below are the v3 run. After the v3.1 hotfix the suite is
> **190 tests: 189 passed, 1 failed** (the same pre-existing
> `test_local_execution.py::test_shipped_local_example_config_is_valid` missing-file test).
> See `RUNTIME-V3.1.md` §6 for the v3.1 evidence and real-pi smoke.

`pytest` in the repo (temp DBs, fake pi, no live writes): **161 passed, 1 failed** — the
only failure is the pre-existing `test_local_execution.py::test_shipped_local_example_config_is_valid`
(the symlinked `dispatch.local.example.yaml` is missing; it failed identically before this
round, on an untouched file).

`tests/test_runtime_v3.py` — 47 tests:

| Area | Tests |
| --- | --- |
| tool surface | `test_chat_tools_default_to_control_only`, `test_build_argv_applies_the_tool_policy`, `test_runtime_mode_switch` |
| escaping / prompts | `test_delimiter_escaping_in_chat_context`, `test_worker_prompts_warn_about_untrusted_data`, `test_worker_prompt_rendering_is_single_pass`, `test_steering_text_escapes_delimiters_and_newlines` |
| project binding | `test_control_client_rejects_cross_project`, `test_control_client_url_encodes_path_segments`, `test_mcp_write_tools_do_not_accept_project_id`, `test_mcp_bound_session_cannot_read_other_project` |
| approvals | `test_approval_decision_is_atomic` (20-way race), `test_expiry_is_applied_on_reading`, `test_approval_is_single_use_and_policy_documented`, `test_approval_gate_binds_the_action_hash`, `test_approval_gate_requires_a_fresh_consumable_approval`, `test_approval_consume_endpoint_is_single_use`, `test_approvals_are_expired_in_chat_context`, `test_chat_approval_extension_fails_closed` (real node, real JS) |
| feed | `test_overview_recent_activity_is_newest`, `test_overview_reports_newest_in_large_project`, `test_null_timestamp_cursor_pagination`, `test_kinds_filter_applies_before_limit` |
| tailer / orphans | `test_jsonl_tailer_survives_split_utf8`, `test_jsonl_tailer_keeps_unicode_separators_inside_records`, `test_cancelled_request_kills_process_group`, `test_startup_sweep_kills_orphan_and_replays_jsonl`, `test_tailer_persists_offset_sidecar`, `test_replay_resumes_from_persisted_offset` |
| steering / priority | `test_mark_steering_delivered_respects_acceptance`, `test_reason_task_does_not_deliver_steering_on_spawn_failure`, `test_select_unclaimed_intent_priority_tiebreak` |
| RPC | `test_rpc_turn_end_to_end`, `test_rpc_live_steer`, `test_rpc_steer_rejects_idle_and_json_mode`, `test_rpc_completes_on_agent_settled_not_agent_end`, `test_rpc_crash_recovery`, `test_rpc_stdout_contamination_is_recorded_not_fatal`, `test_rpc_stdout_backpressure` (3000 deltas), `test_rpc_response_event_interleaving`, `test_rpc_late_events_after_settle_are_kept`, `test_rpc_idle_cap_closes_warm_session`, `test_rpc_one_process_per_conversation`, `test_rpc_drops_stale_queue_at_turn_start`, `test_rpc_argv_wires_approval_extension` |
| migration | `test_migration_adds_v3_columns` |

### Real pi smoke (temp server, copied DB, port 8016/8017)

| Scenario | Result |
| --- | --- |
| cold RPC turn ("Reply with exactly CAIRN_V3_OK") | `CAIRN_V3_OK`, 15 activities, 11.9 s (pi startup) |
| warm turn (same conversation) | 3.7 s, same pi session id, process reused |
| control tool | model called `mcp__cairn_control__graph_overview` and answered "63 facts and 2 open intents (i061, i063)" |
| live steer | `200 queued` mid-stream → the model stopped and replied `CAIRN_STEER_OK`; `chat_activities(kind=steering,status=queued)` + project feed row |
| feed paging | 21 pages, 144 unique items, no duplicates/gaps, `~#` cursors on the untimestamped facts |
| overview | `recent_activity_order=newest_first`, newest row first |
| approvals race | 16 concurrent decisions over HTTP → 1×200, 15×409, one activity transition |
| kill + restart | orphan pi (PID 229329) killed on startup, 52 JSONL lines replayed, run closed as `stopped` |

---

## 11. Configuration (server env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAIRN_CHAT_RPC` | `1` | `0` falls back to the one-shot `--mode json` path |
| `CAIRN_CHAT_TOOLS` | unset → `mcp__cairn_control__*` only | chat tool allowlist (`none` disables all tools) |
| `CAIRN_CHAT_RPC_IDLE_SECONDS` | `900` | warm-session idle cap |
| `CAIRN_CHAT_RPC_MAX_SESSIONS` | `8` | LRU cap on warm sessions |
| `CAIRN_CHAT_STEER_TIMEOUT` | `20` | seconds to wait for pi's `steer` response |
| `CAIRN_CHAT_TIMEOUT` | `300` | per-turn timeout (abort + close on expiry) |
| `CAIRN_CHAT_CONTROL` | `1` | load `cairn-control.js` |
| `CAIRN_CONTROL_URL` | `http://127.0.0.1:8000` | Cairn API for the control MCP + approval gate |
| `CAIRN_APPROVAL_ACTIONS` | **unset = `add_hint,add_intent,set_project_status,steer_intent`** | control actions that require approval; explicit empty/`none` disables the gate (v3.1) |
| `CAIRN_CHAT_APPROVAL_TOOLS` | empty | pi tool patterns gated in chat (`bash`, `write*`, ...) |
| `CAIRN_CHAT_PROJECT_CWD` | `0` | v3.1: `1` (+ built-in tools) runs chat in `runs/<project>`; default is `runs/chat/<id>` |
| `CAIRN_CHAT_TRUST_PROJECT_CONTEXT` | `0` | v3.1: `1` (+ built-in tools) allows discovered context/skills/templates/themes |
| `CAIRN_CHAT_ISOLATE_AGENT_DIR` | `1` | v3.1: per-session `PI_CODING_AGENT_DIR`; `0` restores the shared one |
| `CAIRN_CHAT_PI_SOURCE_AGENT_DIR` | `~/.pi/agent` (or inherited `PI_CODING_AGENT_DIR`) | v3.1: source for the copied auth/model config |
| `CAIRN_CHAT_STOP_FINISH_TIMEOUT` | `12` | v3.1: max wait before `POST /stop` answers `stopped:false` |

---

## 12. Remaining gaps

1. **Worker mid-turn steering is not implemented** (phase-2 design in §8.6).
2. **Worker/container tool approvals are not implemented** (§4.4 lists the exact wiring).
3. **The REST API is still unauthenticated and localhost-only.** Approvals are advisory at
   the REST layer by design; enforcement lives in the two execution layers.
4. **Context snapshot staleness.** An RPC session keeps the `--append-system-prompt` context
   from spawn time; live counts come from the control tools. A very long warm session
   therefore sees an older snapshot until it is reaped.
5. **Steer/complete race.** If a turn settles in the ~ms between the `_active` check and the
   stdin write, pi queues the message; the next turn's `clear_queue` drops it and records a
   `dropped` steering row (no silent delivery).
6. **`chat_extensions/*.js` are resolved from the source tree**; a non-editable wheel build
   needs package-data config (chat degrades to no control tools).
7. **Feed merging is still Python-side** for facts/intents/hints; fine at current sizes,
   needs SQL UNION at 10k+ rows.
8. **JSONL replay can duplicate at most one read batch** if the process dies between feeding
   a batch and writing the offset sidecar (the sidecar is written after each batch).
9. **Old pi builds without `--mode rpc`** fail the turn with `pi rpc process is not running`
   (stderr tail preserved). Set `CAIRN_CHAT_RPC=0` for those hosts.
10. **`_reconcile_stale_run` and the startup sweep disagree on status naming**: a restart sets
   `stopped`/`idle`, a lost turn inside a live server sets `error`. Both are honest; noted so
   the UI treats them intentionally.

### v3.1 additions to this list

11. **Chat isolation is structural, not a same-UID sandbox** (see `RUNTIME-V3.1.md` §8.3):
    workers run as the same OS user, so a worker that deliberately writes into
    `runs/chat/<id>` could still plant a file. The runtime no longer *points* pi at
    worker-writable directories, rebuilds the per-session agent dir, disables context/skill/
    template/theme discovery and forces `defaultProjectTrust: "never"`.
12. **The gated MainAgent write blocks for up to `CAIRN_APPROVAL_WAIT` (90 s default)** while
    the approval is pending; on timeout the tool answers "pending approval" (never a success).
13. **`stop` is bounded** by `CAIRN_CHAT_STOP_FINISH_TIMEOUT`; an unlanded stop is reported
    `stopped:false` and the UI must poll.
14. **Sweep identity depends on `/proc`** (cmdline/environ/stat); without `/proc` the sweep
    refuses to kill (fail-safe).

---

## 13. Live restart (NOT run)

> **v3.1.** The live server served **v3** when the hotfix was written (PID 239359); it was not
> restarted. The restart command below is unchanged; see `RUNTIME-V3.1.md` §9 for the v3.1
> notes (one extra migration: `chat_runs.pid_start_ticks`, and the default approval gate is
> now ON).

```bash
systemctl --user restart cairn-server.service
# or: kill <pid>, then
cd /home/vic/.local/share/artex-tools/cairn/cairn && \
  .venv/bin/cairn serve --host 127.0.0.1 --port 8000 \
    --db-path /home/vic/.local/share/artex-tools/cairn/data/cairn.db --no-access-log
```

Migrations are idempotent and run on startup (`chat_runs.log_path/log_offset/mode`,
`chat_runs.pid_start_ticks`, `approval_requests.action_hash/consumed_at/consumed_by`, the
expiry index). The startup sweep only kills a pi process whose identity it can prove; anything
else is logged and left alone.

Rollback: `git checkout` the tree (or restore the previous `.py` files) and restart; the new
columns are additive and harmless to v2 code. Set `CAIRN_CHAT_RPC=0` to keep v3 running on the
old one-shot path without a rollback.

The dispatcher can keep its existing command line (no dispatcher restart is required for
these changes; restarting it only picks up the steering acceptance fix).
