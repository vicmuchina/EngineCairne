# Cairn full stack — how it runs on this machine, and how to rebuild it

This is the **host-specific** companion to
[`cairn/REPLICATE.md`](cairn/REPLICATE.md) (the engine's own generic guide).
It documents the actual production wiring: three systemd user units, an Nginx
authenticated proxy, a Cloudflare Tunnel, the Artex app beside it, and the failure
modes we hit while operating it.

---

## 1. Component map

```
                       Internet
                          │
                 Cloudflare Tunnel  (cloudflared.service)
                          │  hostnames → 127.0.0.1:8001 / 8002
        ┌─────────────────┴──────────────────┐
        │                                    │
  evolve.feeltheagi.co.ke              extra.feeltheagi.co.ke
  nginx :8001 (Basic auth)             nginx :8002 (Basic auth, /api/ exempt)
        │                                    │
  cairn-web :3001 (Next.js prod)        Artex :8787 (Go, own JWT)
        │  /api/* rewrite                  │
        └────────────► Cairn API :8000 ◄───┘ (same host, 127.0.0.1)
                          │
                  SQLite cairn.db
                          ▲
                 cairn-dispatcher
                          │ spawns
                 pi workers (up to 3)
                          │
                  JSONL events → /projects/{id}/workers
```

| Unit | Port | Role |
|---|---|---|
| `cairn-server.service` | 8000 (loopback) | FastAPI: graph, chat, approvals, workers, sessions |
| `cairn-dispatcher.service` | – | claims intents, runs `pi`, streams transcripts |
| `cairn-web.service` | 3001 (prod build) | Cairn console UI (Artex-forked) |
| `artex.service` | 8787 + proxy 8788 | Artex pentest console (separate stack) |
| `cloudflared.service` (system) | – | public hostnames → Nginx listeners |

Nginx only listens on **loopback**. Nothing is exposed directly.

---

## 2. Filesystem layout

```
/opt  (equivalent here: user home)         # engine runtime
  Projects/.private/artex-tools/cairn/     # live root
    cairn/                                 # engine source + .venv
    data/cairn.db                          # SQLite (0600)
    runs/proj_00X/{i001,resp,...}          # per-intent worker workspace
    dispatch.yaml                          # live dispatcher config
    logs/                                  # (optional)

  Projects/.arx/research/cairn-web/        # UI source (this repo)
  Projects/.arx/app/                       # Artex source + binary (repo: Artex)

~/.config/systemd/user/
  cairn-server.service  cairn-dispatcher.service  cairn-web.service
  cairn-dispatcher.service.d/cpu.conf             # CPUQuota=300%

/etc/nginx/sites-available/
  cairn          # evolve → :3001
  cairn-extra    # extra  → :8787
/etc/nginx/cairn/{.htpasswd,artex.htpasswd}
/etc/cloudflared/config.yml
```

`~/.local/share/artex-tools/cairn` → `~/Projects/.private/artex-tools/cairn` (symlink used by
the systemd units).

---

## 3. Prerequisites

* Python 3.12 + `uv` (engine)
* Node 22 (UI build, and the `pi` worker CLI)
* `pi` 1.4.0 on `PATH`, logged in, with a model provider
* Nginx (apt), `htpasswd` (`apache2-utils`), `cloudflared`
* Artex: Go 1.26+, Docker (its Postgres runs as `artex-pg`), Node 20+

---

## 4. Rebuild from zero

### 4.1 Engine + database

```bash
git clone https://github.com/vicmuchina/EngineCairne.git "$HOME/cairn-src"
cd "$HOME/cairn-src/cairn"
uv sync
mkdir -p ../data
.venv/bin/cairn serve --host 127.0.0.1 --port 8000 \
  --db-path "$HOME/cairn-src/data/cairn.db" --no-access-log
```

The schema is created on first connect. Check `curl -s 127.0.0.1:8000/projects`.

### 4.2 pi worker

```bash
npm install -g @earendil-works/pi-coding-agent
```

Provider lives in `~/.pi/agent/models.json`. This machine uses an OpenAI-compatible
gateway whose key is fetched by a command (no secret at rest):

```json
"opencode-go": {
  "type": "openai-completions",
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "apiKey": "!python3 ~/.zcode/cli/get-opencode-key.py opencode-go",
  "models": [{ "id": "deepseek-v4.1-flash", ... }]
}
```

Verify with the one-shot JSONL command in `cairn/REPLICATE.md` §3.

### 4.3 Dispatcher config

The live config is copied verbatim to [`deploy/dispatch.yaml`](deploy/dispatch.yaml):
local execution, `max_workers: 3`, `max_project_workers: 3`, 1200 s explore timeout,
`workspace_root: /home/vic/.local/share/artex-tools/cairn/runs`.

```bash
cp deploy/dispatch.yaml "$HOME/Projects/.private/artex-tools/cairn/dispatch.yaml"
```

> The dispatcher must run with a **clean environment**. Do not start it from an agent
> shell that exports `PI_SESSION_ID` / `PI_SESSION_FILE`: the child `pi` then attaches to a
> live session and waits on stdin forever (this happened; see §7).

### 4.4 systemd units

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/*.service ~/.config/systemd/user/
mkdir -p ~/.config/systemd/user/cairn-dispatcher.service.d
cp deploy/systemd/cpu.conf ~/.config/systemd/user/cairn-dispatcher.service.d/
systemctl --user daemon-reload
systemctl --user enable --now cairn-server.service cairn-dispatcher.service
```

Edit the paths inside the unit files if your layout differs. `Restart=always` is
mandatory on the dispatcher: the scheduler watchdog exits **75** to self-heal a wedge.

### 4.5 UI

```bash
cd "$HOME/Projects/.arx/research/cairn-web"
npm ci
npm run build                      # production build (no dev overlay)
```

```ini
# ~/.config/systemd/user/cairn-web.service
[Service]
WorkingDirectory=/home/vic/Projects/.arx/research/cairn-web
Environment=NODE_ENV=production
Environment=CAIRN_API=http://127.0.0.1:8000
ExecStart=/home/vic/Projects/.arx/research/cairn-web/node_modules/.bin/next start -p 3001
Restart=always
```

`CAIRN_API` drives the `/api/*` rewrite in `next.config.mjs`. The UI needs no other env.

> Do **not** serve the domain from `next dev`. The dev overlay turns React development
> warnings into a full-screen error page, and a long-running dev server can go stale enough
> to break client chunks.

### 4.6 Nginx + auth

Copy [`deploy/nginx/cairn.conf`](deploy/nginx/cairn.conf) and
[`deploy/nginx/cairn-extra.conf`](deploy/nginx/cairn-extra.conf) into
`/etc/nginx/sites-available/`, symlink into `sites-enabled/`, then:

```bash
sudo mkdir -p /etc/nginx/cairn
sudo htpasswd -c /etc/nginx/cairn/.htpasswd <user>     # evolve
sudo htpasswd -c /etc/nginx/cairn/artex.htpasswd <user> # extra
sudo nginx -t && sudo systemctl reload nginx
```

`cairn-extra` deliberately sets `auth_basic off` on `/api/`: the Artex app has its own JWT,
and browsers do not reliably re-send cached Basic credentials for `fetch()`.

### 4.7 Cloudflare Tunnel

`/etc/cloudflared/config.yml` maps the two public hostnames to
`http://127.0.0.1:8001` and `http://127.0.0.1:8002`. Credentials live in
`/etc/cloudflared/*.json` and are never in this repo. After editing:

```bash
sudo cloudflared tunnel ingress validate
sudo systemctl restart cloudflared
```

---

## 5. Verification gates

Run these in order; stop at the first failure.

```bash
# 1. services
systemctl --user is-active cairn-server cairn-dispatcher cairn-web   # 3 × active

# 2. API
curl -s 127.0.0.1:8000/projects | head -c 120

# 3. watchdog/reconciliation line
journalctl --user -u cairn-dispatcher -n 20 --no-pager | grep -E "watchdog armed|reconciliation"

# 4. one worker run, end to end
curl -s "127.0.0.1:8000/projects/proj_005/workers?limit=1&include_transcript=false" | python3 -m json.tool

# 5. sessions API used by the UI
curl -s 127.0.0.1:8000/projects/proj_005/sessions | python3 -m json.tool | head -40

# 6. UI (loopback bypasses the public gate, not the app)
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3001/projects/proj_005   # 200
```

Expected dispatcher log on a fresh start:

```
INFO scheduler.watchdog scheduler watchdog armed timeout=120.0s check_interval=5.00s exit_code=75
INFO scheduler.loop claim reconciliation completed startup=True projects=2 released=0 stale_after=1800s
```

---

### Sessions v2 (what the console renders)

The engine merges the execute and conclude phases of one intent into a single session
(`phases`, summed `usage`, merged transcript). A cancelled/timed-out run writes a
`worker_interruption` row with reason, turns, duration, tokens and the tool in flight, so
the console can render the Artex interruption card. Open intents with no worker appear as
`queued:<intent_id>`; the planner lane exposes `round` and a parsed `summary`
(intents / complete / none / interrupted).

`GET /projects/{id}/report` returns a deterministic Markdown report (engagement summary,
goal, constraints, statistics, confirmed facts, scope and coverage, findings, retests,
intent ledger, reproducibility, retest plan, appendix). No LLM is involved, so it is
reproducible byte-for-byte for the same graph.

### Domain layer (entities, findings, retests, coverage)

The fork also carries Artex's domain model as an additive layer over facts/intents; the
contract is [`cairn/DOMAIN-LAYER.md`](cairn/DOMAIN-LAYER.md). Operators only need:

- `GET /projects/{id}` now returns `entities`, `findings`, `retests`, `coverage` alongside
  the graph; the endpoints under `/projects/{id}/entities|findings|retests|coverage` are
  documented there.
- **No profiles.** Entities/findings/retests are written by workers through the same API;
  the console shows *Test assets*, *Asset coverage*, *Retests* and first-class *Findings*
  only when the data exists. A facts-only project keeps the original seven tabs.
- **Coverage is derived**, not stored: `tested / (in-scope ∪ anchored)`, anchored = linked
  to a fact or a concluded intent. A zero denominator renders `—`, never a fake 100%.
- **Retests are intents** (`kind='retest'`, `retest_of=<finding>`), so they run through the
  normal dispatcher and appear in Conversations/Sessions. One active retest per finding;
  verdicts seal once terminal; a conclude without a posted verdict becomes `inconclusive`.

Verify after a rebuild:

```bash
curl -s 127.0.0.1:8000/projects/proj_006/coverage | python3 -m json.tool
curl -s 127.0.0.1:8000/projects/proj_006 | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d))"
# → ['coverage','entities','facts','findings','hints','intents','project','retests', ...]
```

## 6. Operating it

| Task | Command |
|---|---|
| Tail dispatcher | `journalctl --user -u cairn-dispatcher -f` |
| Restart engine | `systemctl --user restart cairn-server` |
| Pause a campaign | UI **Pause** or `PUT /projects/{id}/status {"status":"stopped"}` |
| Resume | `PUT … {"status":"active"}` — dispatcher picks the highest-priority open intent |
| Release stuck claims | `POST /projects/{id}/claims/reconcile` |
| Rebuild UI after edits | `npm run build && systemctl --user restart cairn-web` |
| Check frozen cgroup | `systemctl show -p FreezerState cairn-dispatcher.service` |
| CPU cap | `cairn-dispatcher.service.d/cpu.conf` → `CPUQuota=300%` |

**Semantics worth knowing**

* `stopped` **cancels running workers**; it is not a graceful "finish then stop".
* Intent `priority` only **orders** the queue. The dispatcher keeps filling free slots, so
  priority cannot exclude intents.
* `max_workers` × `max_project_workers` bound total concurrent `pi` processes.
* Worker transcripts are persisted per run (`project_activity.run_id`) and survive restarts.
* Sessions UI polls `/sessions` and `/sessions/{key}/activities` every second; the SSE
  endpoint is optional.

---

## 7. Failure playbook (all observed in production)

### 7.1 Dispatcher alive, zero progress, journal ends mid-task
The systemd cgroup was **frozen** (`FreezerState=frozen`), not the Python loop. All threads
parked in `get_signal`, RSS ~5 MB. `Restart=always` does not act on a frozen unit.

```bash
systemctl show cairn-dispatcher.service -p FreezerState   # frozen?
sudo systemctl unfreeze cairn-dispatcher
systemctl --user restart cairn-dispatcher
```

The V4 watchdog (`exit 75` after 120 s without progress) makes the *code* side self-heal;
the freeze itself is an OS/systemd action and needs the unfreeze above.

### 7.2 Worker starts, emits nothing, no network sockets
Child `pi` inherited `PI_SESSION_*` from the shell that launched the dispatcher and waited
on stdin. Fix: launch with a clean env (systemd units do). `pi` sets its process title, so
`ps` shows a bare `pi` and hides argv — check `/proc/<pid>/cmdline` and `ss -tnp`.

### 7.3 "Resumed, but no output"
Resume only flips status. The dispatcher still needs an **open, unclaimed** intent. Check
`intents.worker` for stale claims and call `POST /claims/reconcile`.

### 7.4 Runs complete but token totals look small
Fixed in RUNTIME-V4: usage is folded from every `message_end`, including tool-call-only
turns (`worker_usage` accounting rows that are never persisted as transcript entries).

### 7.5 UI shows a full-screen "Element type is invalid" / "script tag" overlay
Two distinct causes we hit:
1. `next dev` serving a **stale webpack graph** after long uptime → restart dev, or better,
   serve a production build (`npm run build` + `next start`).
2. `next/script` rendered from a nested server component in this Next 16 build resolves to
   a lazy promise. The boot script is back to an inline `<script>`; the React warning it
   emits exists only in development, which is another reason the domain runs a prod build.

### 7.6 Artex keeps prompting for Basic auth after login
The nginx log showed `/api/tasks` and `/api/intercept/pending` re-challenging. Fixed by
`location ^~ /api/ { auth_basic off; }` in `cairn-extra` (the app uses its own JWT).

---

## 8. Security model

* Cairn has **no built-in authentication**. The only gate on the internet path is Nginx
  Basic auth. Do not remove it while the API is reachable.
* `POST /projects` + an open dispatcher = arbitrary command execution as the service user.
  Treat access to the UI/API as shell access to this host.
* The SQLite DB contains prompts, tool output and findings in plaintext. Keep it `0600`.
* `pi` keys are command-fetched (`!…`) so `models.json` can be copied without a secret.
* `htpasswd` files and Cloudflare tunnel credentials are host-only and never committed.

---

## 9. Provenance / syncing this folder

`cairn/` is a vendored copy of **EngineCairne** at commit **`72ae490`**
(RUNTIME-V4). `cairn-web/` is a fork of the Artex web frontend, wired to the Cairn API.

To refresh the vendored engine after an EngineCairne change:

```bash
git clone https://github.com/vicmuchina/EngineCairne.git /tmp/EngineCairne
rsync -a --delete --exclude='.git/' --exclude='node_modules/' \
  --exclude='.venv/' --exclude='__pycache__/' \
  /tmp/EngineCairne/ cairn/
# update the commit id above, then commit
```

The live engine is synced the other way: edit in the repo, then
`rsync -a --delete <repo>/cairn/ ~/Projects/.private/artex-tools/cairn/cairn/` and restart
`cairn-server`.
