# Sessions v2 — merged worker sessions, queued intents, planner summary, interruptions, report

Status: implemented (backend), 236 tests passing. Contract: `/tmp/cairn-parity/sessions-v2-backend.md`.
Scope: `src/cairn/server/*`, `src/cairn/dispatcher/workers/*`. No schema change, no row
deletion, no run/job semantics change; every new field is additive.

## 1. One session per intent (execute + conclude merged)

`src/cairn/server/sessions.py`

* `_worker_sessions` now groups non-planner runs by `intent_id` (fallback `run_id`):
  `_merge_run_groups` → newest execute run (`bootstrap|explore`) + newest
  `*_conclude` run of the same intent. Older retries stay in `runs[]` (provenance) but no
  longer become their own session.
* Emitted `WorkerSession` (all pre-existing fields kept):
  * `key` = `worker:<execute run_id>` (conclude id only when no execute exists)
  * `title` = `#<run8> <intent_description>` (unchanged style)
  * `status` = `success` when the conclude succeeded, or the execute succeeded and no
    conclude exists; `running` when any phase is open; else the execute status
    (`timeout|failed|cancelled`)
  * `phases` = `{"execute": status|null, "conclude": status|null}`
  * `started_at`/`finished_at` = earliest start / latest finish; `duration_ms` = sum of
    phase durations (timestamp-span fallback)
  * `tokens`/`usage`/`counts` = sum over phases; `model` = newest phase model
  * `runs` = `[{run_id, task, status, started_at, finished_at, duration_ms, usage, model}]`
  * `interrupted` + `interrupt_reason` (`paused_by_user` when the project is stopped,
    `timeout` when a phase timed out, else `cancelled`) — only when the terminal status is
    `cancelled|timeout` and no conclude succeeded
* Sort: live/running first, then queued, then newest-finished (workers stay newest-first).
* `GET /projects/{id}/sessions/worker:<run_id>/activities` accepts **either** phase's run
  id (`_merged_run_ids`) and returns the merged transcript ordered by
  `project_activity.id`, keyed by the execute run id. SSE (`session_key_for_activity`)
  maps a conclude row to the same merged key.

Evidence (proj_006): `#038144da` (102 tool calls, `timeout`) and `#536bff68`
(`bootstrap_conclude`, `success`) are now **one** session `worker:038144da…` with
`status=success`, `phases={execute:timeout, conclude:success}`, summed tokens, and the
final fact message inside its activities.

The existing `exclude_task="reason"` regression fix is unchanged
(`test_worker_exclude_task_keeps_explore_sessions_visible` still passes); the merge only
reads non-planner runs.

## 2. Queued intents

`_queued_sessions`: open intents (`concluded_at IS NULL AND worker IS NULL`) that are not
already a session, not the bootstrap intent (`creator='dispatcher.bootstrap'`), capped at
25, only when the project is not `completed`:

```
{key: "queued:<intent_id>", role: "worker", title: "#queued <desc>", status: "queued",
 live: false, queued: true, intent_id, intent_description, tokens/counts zeros,
 last_activity_at: null, started_at: null}
```

`GET .../sessions/queued:<id>/activities` → `{items: [], has_more: false, earliest_seq: 0}`
(404 for an unknown intent).

## 3. Planner round + summary

* `round` = count of distinct `task=reason` runs for the project.
* `summary` parsed from the newest reason run's last `worker_message`
  (`_parse_planner_payload` strips code fences and picks the `{...}` block that consumes the
  most text — the outer envelope, not a nested object). Both shapes are accepted:
  `{"kind":"intents"|"complete"|"none", ...}` and the raw pi envelope
  `{"accepted": true, "data": {"intents":[…]} | {"complete": …} | {}}`.
* `summary_text`: `Proposed N intents` / `Goal satisfied` / `No new intents this round` /
  `Interrupted before a plan was returned`.
* A cancelled/timed-out round without a parseable message → `summary.kind="interrupted"`
  plus `summary.interruption` (reason, terminal state, turns, duration, usage, tool in
  flight, `text`).

Evidence (proj_005): newest reason run `0b4967ff` is cancelled with no envelope →
`round=194`, `summary.kind=interrupted`, reason `paused_by_user`, 1 turn, 2m28s.

## 4. Interruption row (dispatcher)

`src/cairn/dispatcher/workers/pi_events.py` — `PiWorkerEventParser.interruption_snapshot()`
returns the open tool (name/call id/input), assistant turn count and last thinking text.

`src/cairn/dispatcher/workers/activity.py` — on `finish()` with terminal `cancelled` or
`timeout`, one `worker_interruption` row is queued **before** the terminal `worker_run`
row: `status="done"`, `title="Worker run interrupted"`,
`metadata={reason, terminal_state, turns, duration_ms, usage, tool, thinking}`, description

```
The run was interrupted: {reason}. Terminal state: {status}.
Executed: {turns} model turns. This run took: {duration}.
Cumulative tokens: input … / output … / cache read ….
Tool running at interruption: {tool_name} {tool_input} (returned no result).
```

`reason` = `paused_by_user` (cancel reason `stopped`), else `timeout`/`cancelled`.
`sessions.py` maps `worker_interruption` → activity kind `interruption`; the server's
`WORKER_CHILD_KINDS` now includes it, so it is part of the worker transcript.

## 5. Report endpoint

`GET /projects/{id}/report` → `{project_id, generated_at, markdown, counts}` (new
`src/cairn/server/report.py`, router `routers/report.py`). Deterministic Markdown from the
graph only: engagement summary, goal, operator constraints, results table (facts, findings,
open/completed intents, work runs, tool calls, tokens, wall clock), confirmed findings with
evidence and transcript URL, intent ledger, verification & reproducibility (run table +
replay `curl` calls), retest plan, appendix of all facts. Descriptions clip at 8 KB, table
cells are escaped, total output capped at ~200 KB; no secrets are read.

## Test evidence

`PYTHONPATH=src <venv>/bin/python -m pytest -q` → **236 passed** (was 227 before this
change; 9 new tests):

* `tests/test_runtime_v4.py::test_sessions_merge_execute_and_conclude_into_one_worker`
* `::test_sessions_interrupted_worker_keeps_timeout_reason`
* `::test_sessions_list_queued_intents_and_empty_transcript`
* `::test_plan_session_exposes_round_and_parses_summary_shapes` (intents / complete / none /
  interrupted)
* `::test_report_endpoint_renders_deterministic_sections`
* `tests/test_worker_activity.py::test_recorder_writes_interruption_row_before_terminal_row`
* `::test_recorder_interruption_row_for_timeout_and_no_open_tool`
* `::test_parser_interruption_snapshot_reports_open_tool_and_turns`
* `::test_session_activities_map_interruption_rows`

Live verification: `/projects/proj_006/sessions`, `/projects/proj_005/sessions`,
`/projects/proj_006/report`, `/projects/proj_004/sessions` (queued lane — proj_005's
intents are all concluded/claimed in the current DB, so its queued lane is legitimately
empty).

## Residual risk

1. Existing cancelled/timed-out runs recorded before this build have no
   `worker_interruption` row; backfilling would mean writing evidence rows, which is
   deliberately not done. The planner lane still explains them via `summary.interruption`.
2. The live dispatcher keeps the old code until it is restarted (not restarted here by
   contract); new interruption rows appear from the next cancelled/timed-out run.
3. `runs[]` includes older retries while the transcript endpoint shows the newest
   execute+conclude pair only (provenance is listed, not replayed).
