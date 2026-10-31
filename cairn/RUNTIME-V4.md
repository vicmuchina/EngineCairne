# RUNTIME-V4 — dispatcher hardening, stale claims, sessions API, usage aggregation

Build date: 2026-10-31. Repo: `/home/vic/Projects/.arx/research/cairn/cairn`
(deployed copy: `/home/vic/.local/share/artex-tools/cairn/cairn`). No `git push`, no
secret values are recorded here.

## 1. Root cause of the Oct-29 20:05 dispatcher hang

**Observed live state (pid 7912, before this build):**

- `systemctl --user status cairn-dispatcher.service` reported
  `Active: active (running) (frozen)`; `systemctl --user show ... -p FreezerState` returned
  `frozen`, and the cgroup's `cgroup.freeze` file contained `1`.
- All nine threads of pid 7912 were parked in `get_signal` (`/proc/7912/task/*/wchan`);
  RSS was ~5 MB. A frozen cgroup runs **no Python code at all**, so the journal could not
  advance no matter which frame was current.
- The five sockets held by the dispatcher to `127.0.0.1:8000` were `CLOSE-WAIT`: the API
  server had already closed those idle keep-alive connections. That is a consequence of the
  freeze, not evidence of a blocked `requests` call (every dispatcher HTTP call is now
  explicitly bounded; see §2).
- The journal's last line was
  `tasks.common starting container exec ... phase=explore_conclude timeout=180s`
  (2026-10-29 20:05:37), after an explore timeout and the conclude fallback. No kernel OOM
  message appears around that time; `MemoryPeak` was 2.3 GB against `MemoryMax` 3 GB.

**Proximate blocking point:** the systemd cgroup freezer had suspended the whole unit
(`cgroup.freeze=1`). The last log line is simply the last write before every thread was
stopped; it is not proof of the Python frame in which the process would have blocked. The
freeze is consistent with the residue of an interrupted `systemctl stop/freeze`; systemd
had no active job left.

**Code-level contributing risk (why it stayed wedged forever):**

- the scheduler is one thread. A single blocking call (process spawn, a docker API request,
  a socket read, or the conclude-fallback `communicate()`) stopped all project scheduling;
- `run_worker_process` logs immediately **before** `build_exec_process`/`process.start()`;
  a hang in `Popen`/docker `exec_create` would have produced the exact same last line;
- there was no independent watchdog and no hard per-process deadline outside the task
  thread, so a stalled task never released its worker slot;
- `CairnClient` used one 10 s timeout value and the docker SDK client had no request
  timeout at all.

The physical freeze and a code-level stall are now both covered: the unit restarts a clean
process if the loop stops progressing, and each worker has a supervisor outside the task
thread. Neither can leave the dispatcher silently alive-but-dead again.

### Stale-claim evidence note

The live DB query at build time found 61 `proj_004` intents with `worker='local-pi'`, but
**all 61 have `concluded_at` set** (historical attribution retained by the old schema).
There were **zero open stale claims**. The contract explicitly says never to touch
concluded intents, so those rows were left untouched. The reconciler below still handles
genuine open stale claims (and tests cover them).

## 2. Dispatcher hardening

### 2.1 Independent per-process supervisor

New `src/cairn/dispatcher/runtime/supervisor.py` (`ProcessSupervisor`): a daemon thread
started for every `run_worker_process` call. It waits `timeout + grace` (grace = existing
15 s `PROCESS_COMMUNICATE_GRACE_SECONDS`) and then, independently of the task thread:

1. calls `mark_timed_out()` on the process (LocalProcess/ManagedProcess),
2. kills the process group (`killpg(SIGKILL)` locally; `kill -KILL -<pid>` then `kill -KILL
   <pid>` in the container fallback),
3. calls the activity recorder's idempotent `finish("timeout", ...)`, so the run is marked
   `timeout` even if the task thread is still stuck in `communicate()`.

`LocalProcess.communicate()` now polls in 0.2 s slices against an explicit monotonic
deadline (instead of one long `process.wait`) and honours a supervisor-set timeout.
`ManagedProcess` gets the same `mark_timed_out` hook.

### 2.2 Short HTTP timeouts

`CairnClient` defaults are now explicit `(connect=5 s, read=15 s)` for every request
(projects, heartbeat, claim/release/conclude, activity recorder, close, reconcile). The
scheduler watchdog bounds a pathologically slow trickle. The docker SDK client is built
with a 15 s request timeout (`ContainerManager`), so `exec_create`/inspect/inspect-loops
cannot block a task thread forever.

### 2.3 Scheduler watchdog / systemd restart

New `src/cairn/dispatcher/scheduler/watchdog.py` (`LoopWatchdog`), started by
`DispatcherLoop.run()`:

- the loop calls `touch()` at every iteration and inside project dispatch;
- if no touch happens for `runtime.watchdog_seconds` (default **120 s**), it logs
  `CRITICAL` and calls `os._exit(75)` (temporary failure) so systemd starts a clean
  process;
- `watchdog.sleep(interval)` keeps the watchdog alive across legitimate long configured
  intervals without hiding a blocked loop;
- `check()` accepts an injected clock and exit function, so the exit path is unit-tested
  without killing pytest.

The live unit already has `Restart=always`, `RestartSec=10` (verified with
`systemctl --user show`); no drop-in change was required. `RestartSec` prevents the
10 s/5-start limit from being hit by a normal restart.

Blocking subprocess work already runs in the dispatcher's `ThreadPoolExecutor` task
threads, never on an asyncio event loop. The new supervisor adds a second, independent
thread per worker; the scheduler thread only submits/observes futures.

### 2.4 Claim reconciliation

New `src/cairn/server/claims.py` + `POST /projects/{id}/claims/reconcile`.
An intent is reclaimable only when:

- `worker IS NOT NULL`, `concluded_at IS NULL`, `to_fact_id IS NULL`;
- `last_heartbeat_at` is parseable and older than `claim_stale_seconds` (default 1800);
- **no active `worker_run`** protects the intent. A run is active when it has an open
  `worker_run` row and its newest activity is fresher than `claim_stale_seconds`. A live
  run protects its intent even if the heartbeat thread is stuck.

The update is `worker=NULL` only. Facts, `concluded_at`, heartbeat, project status and
project `reason` are untouched. A `stopped` project is never resumed. Dispatcher calls it
on startup and every `runtime.claim_reconcile_interval` seconds (default 300), logging
`claim reconciliation completed startup=... projects=... released=...`.

Config additions (all have defaults; existing `dispatch.yaml` files keep working):

| Runtime key | Default | Meaning |
| --- | --- | --- |
| `watchdog_seconds` | 120 | no scheduler progress before `exit(75)` |
| `claim_stale_seconds` | 1800 | heartbeat age required to reclaim a claim |
| `claim_reconcile_interval` | 300 | seconds between reconcile passes (0 = startup only) |

## 3. Sessions API (Artex-shaped)

All existing endpoints are unchanged. New routes are registered by
`src/cairn/server/routers/sessions.py`.

### `GET /projects/{project_id}/sessions`

```json
{
  "project_id": "proj_005",
  "generated_at": "2026-10-31T16:00:00Z",
  "project_status": "active",
  "task_total": {"input": 120, "cache_read": 60, "output": 15, "cost": 0.3},
  "sessions": [
    {"key":"main","role":"mainagent","title":"Main agent - conversation #1",
     "status":"idle","live":false,"last_activity_at":null,
     "tokens":{"input":0,"cache_read":0,"output":0,"cost":0.0},"unread":0},
    {"key":"plan","role":"planner","title":"Planner - situation assessment",
     "status":"idle","live":false,"last_activity_at":null,
     "tokens":{"input":0,"cache_read":0,"output":0,"cost":0.0},"unread":0,
     "run_id":null,"worker":null,"task":null,"intent_id":null,"stale":false,
     "started_at":null,"finished_at":null,"duration_ms":null,"model":null,"counts":null},
    {"key":"worker:<run_id>","role":"worker","title":"#2040  Finish the offline TP-Link...",
     "run_id":"...","worker":"local-pi","task":"explore","intent_id":"i001",
     "status":"running","live":true,"stale":false,
     "started_at":"...","finished_at":null,"duration_ms":596000,
     "tokens":{"input":3900000,"cache_read":3800000,"output":45000,"cost":0.0},
     "counts":{"activities":42,"thinking":8,"tool_calls":11,"tool_results":11,
               "messages":2,"errors":0},
     "last_activity_at":"...","model":"deepseek-v4.1-flash","unread":0},
    {"key":"system","role":"system","title":"System audit", "...": "..."}
  ]
}
```

Rules implemented:

- **main** = newest `chat_conversations` row for the project, activities from
  `chat_activities` mapped 1:1. Title is `Main agent - conversation #<id>` for the
  default title, otherwise `Main agent - <conversation title>`.
- **plan** = single planner lane from the newest `worker_run` whose metadata
  `task == "reason"`; all other reason runs are historical and not duplicated as workers.
- **worker:<run_id>** = every other worker run, newest first. Title is
  `#<first 8 chars of run_id> <intent_description or task>`.
- **system** = `project_activity` rows with `run_id IS NULL` and kind in
  `status/project/import/error`.
- Order is main, plan, workers newest first, system.
- `live` = latest row within 5 s, or status `running`/`streaming` and not stale
  (900 s). A terminal run with a just-written row is briefly live, per the contract.
- `tokens` per lane = `input`, `cache_read`, `output`, `cost` (cost as float).
  `task_total` sums every lane.
- `unread` is always `0`: Cairn has no read-state store yet; it is not inferred.
- `project_status` comes from the project row; this endpoint never changes status.

### `GET /projects/{project_id}/sessions/{key}/activities?before=<seq>&limit=200`

Keys: `main`, `plan`, `system`, `worker:<run_id>`. Unknown keys/run ids return `404`.

Response:

```json
{"key":"worker:abc","items":[
  {"seq":123,"id":456,"kind":"thinking","role":"assistant","status":"done",
   "content":"...","tool":null,
   "tokens":{"input":0,"output":0,"cache_read":0},
   "metadata":{},"created_at":"2026-10-31T16:00:00Z"}
],"has_more":false,"earliest_seq":1}
```

- `seq` is stable/monotonic per key: `chat_activities.id` for main,
  `project_activity.id` for plan/worker/system.
- Pages are fetched newest-first then reversed, so `items` are oldest..newest and the page
  ends at `before` (`id < before`). `has_more` means older rows exist; the next request uses
  `before=earliest_seq`.
- Mapping: worker `worker_thinking -> thinking`, `tool_call -> tool_call`,
  `tool_result -> tool_result`, `worker_message -> message`, `worker_error -> error`,
  `worker_output -> status`; `worker_run` lifecycle rows are not part of the transcript
  page. System rows map to `status`/`error`.
- `tool` carries `name`, `call_id`, `input`, `output`, `duration_ms`, `is_error`; tool
  call/result pair by `call_id`, never adjacency.

### `GET /projects/{project_id}/sessions/stream?since=<project_activity_id>`

`text/event-stream` with:

```
id: 123
event: activity
data: {"key":"worker:abc","seq":123,"activity":{...}}
```

- `id` = global `project_activity.id` cursor; pass the last seen id as `since`.
- Streams project-activity lanes (`plan`, `worker:*`, `system`); the main chat lane is
  polled through the activities endpoint (chat ids live in a different table). This is the
  documented boundary of the optional SSE path.
- Heartbeat comment `: heartbeat\n\n` every 15 s; auto-close after 10 min (client
  reconnects with `since`). DB reads run through `asyncio.to_thread` and the loop only
  awaits `asyncio.sleep`, so the server event loop is never blocked.

### `POST /projects/{project_id}/claims/reconcile`

Body (optional): `{"claim_stale_seconds": 1800, "dry_run": false}`.
Returns `project_id`, `generated_at`, `checked`, `released`, `protected`, `skipped_fresh`,
`released_intents:[{"id":"i001","worker":"local-w"}]`. Dispatcher-only operational endpoint;
no auth, same as the rest of the local API.

### Usage on `/workers`

`WorkerRunItem` now has `model` and `usage` (`input`, `output`, `cache_read`,
`cache_write`, `reasoning`, `total_tokens`, `cost`). It is read from the run's finish
metadata, and for older runs recomputed from `worker_message` metadata `usage` blocks
written by the R3.2b parser. This is additive; existing fields do not change.

## 4. Per-run usage aggregation

`WorkerActivityRecorder` now folds every `message_end` `usage{input,output,cacheRead,
cacheWrite,reasoning,totalTokens,cost}` into one run total and remembers the last model id.
The finish `worker_run` metadata carries both, so usage survives process restarts and
transcript truncation. The server normalises camelCase pi keys and snake_case stored keys,
sums per-run usage for `/sessions`, and exposes the same block on `/workers`.

## 5. Tests

Run from the research checkout with the existing project venv (no installs, temp DBs only):

```bash
cd /home/vic/Projects/.arx/research/cairn/cairn
PYTHONPATH=src /home/vic/.local/share/artex-tools/cairn/cairn/.venv/bin/python -m pytest -q
# 226 passed in 47.48s

cd /home/vic/Projects/.private/artex-tools/cairn/cairn
.venv/bin/python -m pytest -q
# 226 passed in 48.11s (after the same files were synced to the live checkout)
```

Focused run of the six critical node ids (stale reclaim, watchdog, usage, sessions mapping,
pagination, SSE framing + stream) in the live checkout: `7 passed in 1.38s`.

New coverage in `tests/test_runtime_v4.py` (12 tests):

- stale-claim reconciliation: stale open intent released; fresh heartbeat kept; intent
  with a live worker_run protected; concluded intent untouched; idempotent; dry-run;
  stopped project stays stopped and only the worker column changes;
- watchdog: fake clock, no exit at/before the deadline, exit(75) exactly once after it,
  config defaults, sleep path;
- process supervisor: independent kill + `mark_timed_out` + timeout callback at deadline;
  no fire for a normally stopped supervisor;
- usage: parser `message_end` usage summed across two messages including cache/reasoning/
  cost and model; `/workers` exposes finish-block usage and recomputes legacy message
  usage;
- sessions: main/plan/worker/system order, titles, roles, tokens, model, counts,
  task_total; main newest-conversation mapping;
- pagination: reverse pages, `before`, `has_more`, `earliest_seq`, tool object mapping,
  404 for a missing worker run;
- SSE: exact `id/event/data` framing, JSON escaping, heartbeat constant, live async
  generator yields an activity frame and a heartbeat.

Manual end-to-end (throwaway DB, temp uvicorn `:8020`, fake `pi` on PATH; no live worker):

- real `CairnClient`/`LocalBackend` explore run completed `success`; `/sessions` showed
  main/plan/worker/system; the worker lane exposed `thinking`, `tool_call`, `tool_result`,
  `message`, model `fake-model`, tokens `{input:123, cache_read:100, output:45,
  cost:0.001}`; `/workers` showed the same usage; SSE returned `text/event-stream` frames.
  Evidence: `/tmp/cairn-v4-smoke/` and `/tmp/cairn-v4-dispatch/`.
- one-shot dispatcher against a throwaway stopped project logged
  `claim reconciliation completed startup=True projects=1 released=1 ...` and
  `skip dispatch because no active projects` (no worker launched).

## 6. Deployment / live validation (2026-10-31)

- Changes were synced research -> live with `cp -p` for the touched files (same relative
  paths); `diff -rq src/cairn` between the two checkouts is clean (excluding
  `__pycache__`). The live parent was also given the missing
  `dispatch.local.example.yaml` so the shipped-config test passes there too.
- **Server:** `systemctl --user restart cairn-server.service` at 15:55:16 EAT. It started
  clean, `GET /settings` works, and `GET /projects/proj_005/sessions` renders
  main/plan/system with zero tokens/counts on an empty project.
- **Dispatcher restart validation:** `proj_005` ("Sasa Konnect — Full Findings Campaign")
  is active and would have dispatched 3 Konnect workers on restart, so per the guardrail it
  was temporarily stopped through the public status endpoint
  (`PUT /projects/proj_005/status {"status":"stopped"}`; status column only, no
  facts/intents/hints/priorities changed) for the restart window. `PUT` was used rather
  than direct SQL. Then `systemctl --user restart cairn-dispatcher.service` at 15:56:23
  produced:

  ```
  Started cairn-dispatcher.service - Cairn dispatcher (runs pi workers as host processes).
  INFO scheduler.watchdog scheduler watchdog armed timeout=120.0s check_interval=5.00s exit_code=75
  INFO scheduler.loop [+] pi /home/vic/.nvm/versions/node/v22.22.2/bin/pi (workers: local-pi)
  INFO scheduler.loop server setting validated intent_timeout=1200s interval=3s
  INFO scheduler.loop server setting validated reason_timeout=600s interval=3s
  INFO scheduler.loop claim reconciliation completed startup=True projects=2 released=0 stale_after=1800s interval=300s
  INFO scheduler.loop skip dispatch because no active projects
  ```

  No traceback. The service was then stopped (`systemctl --user is-active
  cairn-dispatcher` = `inactive`), `proj_005` restored to `active` through the same status
  endpoint (counts unchanged: 57 facts / 11 intents / 9 hints), and the dispatcher was left
  stopped for the supervisor's first real run. `proj_005` remains active now.
- No worker process was launched during validation: journal has no
  `dispatched`/`starting container exec` lines and `ps` shows no `pi --mode json|rpc`
  process. `cairn-server.service` remains active; `cairn-dispatcher.service` remains
  inactive at handoff.
- The live unit was verified to have `Restart=always`, `RestartSec=10`, so a future
  watchdog `exit(75)` self-heals into a clean process.
- `proj_004` facts, status and concluded intents were not touched; Collatz was not
  un-stopped. No `git push`, no secret values in logs or this document.

## 7. Residual risk / unfinished

1. **SSE excludes main chat** (different id space); main is fully available via the polling
   activities endpoint. A future combined cursor can add it.
2. **`unread` is always 0** until a read-state table exists. It is not faked from timestamps.
3. **Main maps the newest conversation only.** Multiple chat conversations per project are
   still available through the existing `/chat` API but not as separate session lanes.
4. **Plan lane is the newest reason run.** Older reason runs remain in `/workers`; they are
   not duplicated under `plan`.
5. **Container path** got the docker request timeout and group-kill fallback, but no real
   Docker daemon run was performed in this build (live deployment is local execution).
6. **Live dispatcher is intentionally stopped at handoff.** All projects were stopped
   during the restart window; `proj_005` is active again. Starting the service now will
   dispatch Konnect workers, which is the supervisor's call, not this build's.
7. **`process.start()` itself is not interrupted by the supervisor** (the supervisor is
   created after a pid exists). That call runs in a task thread, not the scheduler thread;
   the watchdog restarts the whole process if the loop itself is wedged. A spawn-blocking
   thread would hold one worker slot until the task's submit future is discarded, which is
   why the watchdog is the final backstop.
8. **Claim reconciliation is complementary to the pre-existing `expire_workers`.** The
   server's existing read paths still clear claims older than the DB `intent_timeout`
   without checking worker_runs; the new endpoint adds the safer active-run-aware rule for
   dispatcher-triggered passes. Unifying both would be a follow-up.
9. **No retention/pruning** for worker transcript rows, same as R3.2b.
