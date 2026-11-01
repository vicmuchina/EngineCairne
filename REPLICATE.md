# Replicate Cairn on a fresh machine

An agent-executable guide. Every step has a **check**; do not continue past a failed check.
Tested on Ubuntu 24.04 with Python 3.12.3, Node 22, `pi` 1.4.0, SQLite 3.45.

Cairn has four movable parts; all of them live in this repository:

```
cairn/           → engine: FastAPI + SQLite (fact/intent graph, chat, worker API)
cairn dispatch   → scheduler that runs worker CLIs (pi by default)
worker CLI (pi)  → one process per intent; streams JSONL back into the graph
console/         → Next.js production console (Artex-parity UI)
deploy/          → systemd units, nginx configs and the dispatcher config used in production
scripts/         → import_artex_domain.py (project an imported Artex corpus into the domain layer)
```

Layout:

```text
cairn/       engine source + its own REPLICATE/tests
console/     web console source (build with npm ci && npm run build)
deploy/      host deployment snapshot (systemd, nginx, dispatch.yaml) + examples
docs/        DOMAIN-LAYER, SESSIONS-V2, RUNTIME-V4, CAIRN-STACK
scripts/     maintenance/import helpers
```

Nothing is cloud-hosted and there are no mandatory secrets in this repository.

---

## 0. Host prerequisites

| Tool | Version | Why |
|---|---|---|
| Python | **>= 3.12** | engine runtime |
| [uv](https://docs.astral.sh/uv/) | >= 0.8 | dependency + venv management |
| Node.js | >= 20 | only for the `pi` worker CLI (and the optional web UI) |
| `git`, `curl` | any | obvious |

```bash
sudo apt-get update
sudo apt-get install -y python3.12 python3.12-venv git curl sqlite3 build-essential
curl -LsSf https://astral.sh/uv/install.sh | sh
node -v   # >= 20
```

**Check:** `python3 -V` prints 3.12 or newer, `uv --version` works, `node -v` is 20+.

> The `pyproject.toml` pins `https://mirrors.aliyun.com/pypi/simple` as the default index
> (upstream is China-based). If that mirror is slow or unreachable from your network,
> delete the `[[tool.uv.index]]` block in `cairn/pyproject.toml` before `uv sync`.

---

## 1. Install the engine

```bash
git clone <this-repo> cairn-src
cd cairn-src/cairn
uv sync                   # creates .venv and installs fastapi/uvicorn/click/pyyaml/docker/requests
```

**Check:**

```bash
.venv/bin/python -V
.venv/bin/cairn --help    # prints: dispatch / serve
uv run pytest -q          # 226 passed
```

If tests fail, stop. The engine will not behave correctly.

---

## 2. Create the database

Cairn creates its SQLite schema on first connect; there is no migration tool to run.

```bash
mkdir -p ../data
.venv/bin/cairn serve --host 127.0.0.1 --port 8000 \
  --db-path "$PWD/../data/cairn.db" --no-access-log
```

**Check (new terminal):**

```bash
curl -s http://127.0.0.1:8000/projects | head -c 200
# []
sqlite3 ../data/cairn.db ".tables"
# approvals chat_activities chat_conversations chat_messages chat_runs counters
# facts hints intent_sources intents project_activity projects scoped_counters settings
```

Leave this process running for now.

### Full HTTP surface

| Method + path | Purpose |
|---|---|
| `GET/POST /projects` | list / create (`{title, origin, goal, ...}`) |
| `GET /projects/{id}` | project + facts + intents + hints |
| `PUT /projects/{id}/status` | `{"status":"active"\|"stopped"\|"completed"}` |
| `DELETE /projects/{id}` | remove project |
| `POST /projects/{id}/facts` | write a fact |
| `POST /projects/{id}/intents` | queue an intent |
| `POST /projects/{id}/hints` | inject human guidance |
| `GET/POST /projects/{id}/activity` | activity feed |
| `GET /projects/{id}/workers` | worker runs + pi transcript (thinking/tool_call/tool_result/message) |
| `GET /projects/{id}/sessions` | Artex-style sessions: `main`, `plan`, `worker:<run_id>`, `system` |
| `GET /projects/{id}/sessions/{key}/activities` | reverse-paginated transcript |
| `GET /projects/{id}/sessions/stream` | SSE activity stream |
| `POST /projects/{id}/claims/reconcile` | release abandoned worker claims |
| `GET /export/{id}` | YAML graph snapshot (used by workers) |
| `/chat/...` | main-agent conversations, messages, stop, steer |

Interactive schema: `http://127.0.0.1:8000/docs`.

---

## 3. Install a worker CLI (`pi`)

The dispatcher is worker-agnostic (`pi`, `claudecode`, `codex`, `mock`), but `pi` is the
only driver that streams JSONL tool/thinking events into the graph — which is what the
worker transcript UI reads.

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version     # 1.4.0 tested
```

`pi` resolves its own provider from `~/.pi/agent/models.json`. Cairn **injects no keys**.
Minimal provider entry (any OpenAI-compatible endpoint works):

```json
{
  "providers": {
    "my-provider": {
      "name": "My Provider",
      "type": "openai-completions",
      "api": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "!cat ~/.config/my-provider.key",
      "models": [
        { "id": "my-model", "name": "My Model", "reasoning": true,
          "contextWindow": 200000, "maxTokens": 16384 }
      ]
    }
  }
}
```

`apiKey` may be a **command** prefixed with `!` so no secret sits in the file. The
`deploy/pi/models.example.json` in this repo shows the shape used in production.

**Check:**

```bash
pi --mode json --session-dir /tmp/pi-check --no-extensions --no-skills \
   --no-prompt-templates --no-themes --no-context-files \
   -p "Reply with exactly: OK" < /dev/null | head -3
# {"type":"session",...}  {"type":"agent_start"}  {"type":"turn_start"}
```

A bare `pi` that prints nothing and waits is the failure mode described in
§7 "bare pi on stdin".

---

## 4. Configure the dispatcher

Copy the example and edit paths:

```bash
cp ../dispatch.local.example.yaml ../dispatch.yaml
```

Minimum viable config (this is exactly what production runs, 3 workers):

```yaml
server: "http://127.0.0.1:8000"

runtime:
  execution: local
  worker_healthcheck: disabled
  max_workers: 3
  max_running_projects: 2
  max_project_workers: 3
  interval: 3
  healthcheck_timeout: 15
  prompt_group: "default"
  # watchdog_seconds: 120        # exit(75) if the scheduler makes no progress
  # claim_stale_seconds: 1800    # reclaim abandoned intent claims

tasks:
  bootstrap: { timeout: 1200, conclude_timeout: 120 }
  reason:    { timeout: 600,  max_intents: 2 }
  explore:   { timeout: 1200, conclude_timeout: 180 }

local:
  workspace_root: "/var/lib/cairn/runs"   # any writable dir
  completed_action: keep

workers:
  - name: "local-pi"
    type: "pi"
    task_types: [bootstrap, reason, explore]
    max_running: 3
    priority: 0
```

Start it:

```bash
.venv/bin/cairn dispatch --config ../dispatch.yaml
```

**Check:** the log contains

```
scheduler.watchdog scheduler watchdog armed timeout=120.0s ... exit_code=75
scheduler.loop claim reconciliation completed startup=True ...
```

and, once a project is `active` with an open intent:

```
scheduler.loop dispatched explore project=proj_001 intent=i001 worker=local-pi
tasks.common starting container exec ... phase=explore_execute timeout=1200s
```

If you see `bare pi` behaviour, read §7 before continuing.

### One-shot smoke test (no long-running scheduler)

```bash
.venv/bin/cairn dispatch --config ../dispatch.yaml --once
```

---

## 5. End-to-end proof

Create a project with one intent, then watch it run. `bootstrap_enabled: false`
skips the bootstrap task so the explore intent is immediately claimable:

```bash
curl -s -X POST http://127.0.0.1:8000/projects -H 'content-type: application/json' -d '{
  "title": "smoke",
  "origin": "A scratch project. Goal: prove the dispatcher runs a worker.",
  "goal": "A fact named `probe` exists in this project.",
  "bootstrap_enabled": false
}'
# {"project":{"id":"proj_001",...},"facts":[{"id":"origin",...},{"id":"goal",...}],...}

curl -s -X POST http://127.0.0.1:8000/projects/proj_001/intents \
  -H 'content-type: application/json' \
  -d '{"from":["origin"],"description":"Run `echo probe` with bash, then write fact `probe`.","creator":"human","priority":10}'
```

Then poll:

```bash
curl -s "http://127.0.0.1:8000/projects/proj_001/workers?limit=1&transcript_limit=20" | python3 -m json.tool
```

**Check:** a run appears with `status: running`, then `success`, and the transcript shows
`worker_message` → `tool_call` (`bash`) → `tool_result` → `worker_message`. The same data
is available Artex-style at `/projects/proj_001/sessions`.

---

## 6. Run as services (recommended)

Files are in `deploy/systemd/`. Install the `cairn` user first if you do not run as your
own user (paths below assume `/opt/cairn` and `$HOME=/home/cairn`):

```bash
sudo useradd -r -m -d /home/cairn cairn
sudo -u cairn git clone <this-repo> /opt/cairn/app
sudo -u cairn bash -lc 'cd /opt/cairn/app/cairn && uv sync'
sudo mkdir -p /opt/cairn/data /opt/cairn/runs
sudo chown -R cairn:cairn /opt/cairn

sudo cp /opt/cairn/app/deploy/systemd/cairn-server.service     /etc/systemd/system/
sudo cp /opt/cairn/app/deploy/systemd/cairn-dispatcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cairn-server cairn-dispatcher
```

**Check:** `systemctl status cairn-server cairn-dispatcher` → `active (running)`, and
`journalctl -u cairn-dispatcher -n 20` shows the watchdog line.

> `Restart=always` matters. The scheduler watchdog exits with code **75** when no progress
> is made for `watchdog_seconds`; systemd restarts it into a clean state.

### Security posture

* `cairn serve` has **no authentication**. Bind it to `127.0.0.1` and put an authenticated
  reverse proxy in front of anything internet-facing. An unauthenticated `POST /projects`
  plus an open dispatcher = arbitrary command execution as the service user.
* The dispatcher runs each worker with the service user's permissions, in that user's
  `$HOME`. Treat the dispatcher account as privileged.
* Worker prompts and transcripts are stored in SQLite in plaintext. Keep the DB file
  `0600` and out of the repository.

---

## 7. Troubleshooting (real failures, not theory)

**a) Dispatcher is "running" but never dispatches.**
Check whether systemd froze the cgroup — process alive, zero progress, journal stops:

```bash
systemctl show cairn-dispatcher.service -p FreezerState   # "frozen" is the bug
journalctl -u cairn-dispatcher --since '-10 min' | tail
```

`Restart=always` does **not** restart a frozen unit. Unfreeze and cycle it:
`sudo systemctl unfreeze cairn-dispatcher && sudo systemctl restart cairn-dispatcher`.

**b) Worker starts as a bare `pi` and waits forever.**
Symptom: one `pi` child, no network sockets, `ep_poll`, no JSONL, zero activities.
Cause: the dispatcher inherited `PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_*` from a parent
agent shell, so the child tried to attach to a live session instead of starting fresh.
Fix: start the dispatcher with a clean environment (`systemd` already does this), or
`env -i PATH=... HOME=... cairn dispatch ...`. Diagnostics: `pi` sets its process title,
so `ps` hides argv — inspect `/proc/<pid>/cmdline` or `ss -tnp | grep <pid>` for sockets.

**c) A project shows no workers after Resume.**
`status: active` is not enough: the project needs at least one **unclaimed, open** intent,
and no stale `worker` value on it. Check:

```bash
sqlite3 data/cairn.db \
 "select id,worker,concluded_at from intents where project_id='proj_001';"
curl -s -X POST http://127.0.0.1:8000/projects/proj_001/claims/reconcile
```

**d) Priority did not stop other intents from running.**
Priority only **orders** the queue; the dispatcher keeps filling free worker slots. To run
exactly one intent, either lower `max_project_workers` to `1` and make it the only open
intent, or pause the project — but note: **setting a project to `stopped` cancels its
running workers**, it does not let them finish.

**e) A worker ran but tokens look too small.**
Usage is folded from pi `message_end` events. Tool-call-only turns carry usage without
text; the parser emits a `worker_usage` accounting event for those (not a transcript row),
so run totals cover every turn. If you fork the parser, keep that path.

**f) Where do logs go?**
`journalctl -u cairn-dispatcher` / `-u cairn-server`. The dispatcher also prints one line
per dispatch/skip; `skip dispatch because max_workers reached` is normal.

---

## 8. What is safe to change

| Area | Safe | Needs care |
|---|---|---|
| `dispatch.yaml` worker counts/timeouts | yes | raising `max_workers` multiplies CPU and API spend |
| Adding intents/facts/hints | yes | facts are the evidence trail; do not rewrite history |
| `src/cairn/dispatcher/**` | with tests | changes the process/deadline contract |
| `src/cairn/server/db.py` schema | additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` | existing DBs migrate in place |
| Deleting projects | yes | cascades facts, intents, chat, activity |

Run `uv run pytest -q` after any engine change. 243 tests cover the dispatcher deadlines,
claim reconciliation, worker transcript parsing, usage aggregation, sessions API and SSE,
plus the domain layer (entities, findings, retests, coverage) and report sections.

---

## 9. Domain layer (entities, findings, retests, coverage)

The generalized Artex domain layer is documented in [`cairn/DOMAIN-LAYER.md`](cairn/DOMAIN-LAYER.md).
It is **additive**: `init_db` creates the new tables with `CREATE TABLE IF NOT EXISTS` and
adds `intents.kind` / `intents.retest_of` with guarded `ALTER TABLE`, so an existing database
migrates in place. Nothing about facts, intents or hints changes.

- **Entity** = typed referent; `kind` is a free string. `POST /projects/{id}/entity` upserts
  on `(kind, key)`; `in_scope` is sticky.
- **Finding** = claim backed by a fact (`fact_id`), with free-form `klass` / `severity`.
- **Retest** = an intent with `kind='retest'` + `retest_of=<finding>`; it runs through the
  same dispatcher/worker/session path and posts a verdict (`reproduced|fixed|inconclusive`).
  One active retest per finding; verdicts seal once terminal.
- **Coverage** is derived, never stored: `tested / (in-scope ∪ anchored)`, where anchored
  means linked to a fact or a concluded intent.

`GET /projects/{id}` gains `entities`, `findings`, `retests` and `coverage`. The console shows
**Test assets**, **Asset coverage**, **Retests** and first-class **Findings** only when that
data exists; a facts-only project keeps the original seven tabs. There are no profiles.


---

## 10. Build the console

The console is a Next.js production build; do **not** ship `next dev`.

```bash
cd cairn-src/console
npm ci
CAIRN_API=http://127.0.0.1:8000 npm run build
CAIRN_API=http://127.0.0.1:8000 npm start -- -p 3001
```

**Check:** `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/projects` prints `200`.

The console reads `GET /projects/{id}` (including the additive `entities`, `findings`,
`retests`, `coverage` fields), the sessions API and the activity feed. The full data
contract is in `console/DEPLOY.md`; the domain layer is documented in `docs/DOMAIN-LAYER.md`.

---

## 11. Run the whole stack as services

`deploy/host/` is the exact snapshot from this machine. Adjust the absolute paths
(`/home/vic/...`) and the node path, then install:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/host/systemd/cairn-server.service \
   deploy/host/systemd/cairn-dispatcher.service \
   deploy/host/systemd/cairn-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cairn-server cairn-dispatcher cairn-web
```

**Check:** `systemctl --user is-active cairn-server cairn-dispatcher cairn-web` prints three
`active` lines; `curl -s 127.0.0.1:8000/projects` returns JSON.

For nginx + Cloudflare Tunnel and the failure playbook, see `docs/CAIRN-STACK.md`.
`deploy/dispatch.local.yaml` and `deploy/pi/models.example.json` are starting points for the
dispatcher; `deploy/host/dispatch.yaml` is the production copy.

---

## 12. Bring an imported Artex corpus into the domain layer

Imported Artex tasks store findings as facts (`ARTEX FINDING #N — ...`). The domain layer
wants first-class findings and entities, so the import helper derives them **only from
recorded evidence** (no scanning, no invented assets):

```bash
python scripts/import_artex_domain.py --project proj_005 --dry-run   # inspect
python scripts/import_artex_domain.py --project proj_005             # upsert
```

It creates one finding per `ARTEX FINDING #` fact, extracts hosts/URLs/IPs from
`Assets:` lines and `*.sasakonnect.net` references, anchors every entity to the fact that
mentions it, and parents URL entities to their host. It is idempotent. Re-running is safe.

**Check:** `curl -s 127.0.0.1:8000/projects/<id> | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['entities']), len(d['findings']))"` prints non-zero counts, and the console shows **Test assets**, **Asset coverage**, **Retests**.
