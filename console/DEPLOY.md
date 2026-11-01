# cairn-web — the Cairn console UI

A fork of the Artex web frontend, rewired to the Cairn API. It is the **only** UI for
projects, conversations, worker transcripts, the exploration graph, findings, broadcast
board, approvals and the report.

Part of the full-stack deployment described in [`../CAIRN-STACK.md`](../CAIRN-STACK.md).

## Stack

* Next.js 16 (webpack), React 19, Tailwind, shadcn/ui, G6/React Flow for the graph.
* Same-origin `/api/*` is rewritten to the Cairn server (`CAIRN_API`, default
  `http://127.0.0.1:8000`, prefix stripped). No client-side CORS.
* No auth in the app: the public host is gated by Nginx Basic auth.

## Run

```bash
npm ci
npm run dev -- -p 3001        # development (HMR + dev overlay)
# or, what production runs:
npm run build
npx next start -p 3001
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `CAIRN_API` | `http://127.0.0.1:8000` | upstream used by the `/api/*` rewrite and by `generateStaticParams` at build time |
| `NEXT_PUBLIC_CAIRN_ORIGIN` | `http://127.0.0.1:8000` | origin used by direct client fetches |
| `NEXT_PUBLIC_SSE_BASE` | unset | override SSE base when the UI is served from another origin |
| `NEXT_EXPORT=1` | unset | static export mode (no rewrites; the API must be same-origin) |

> Build-time detail: `src/lib/static-project-params.ts` queries `CAIRN_API` so
> `output: export` can enumerate project ids. If the server is down at build time the list
> degrades to empty and dynamic params still render at request time for `next start`.

## Production service

```bash
npm run build && systemctl --user restart cairn-web
```

Unit: [`../deploy/host/systemd/cairn-web.service`](../deploy/host/systemd/cairn-web.service).

## Data contract

The Conversations view is Artex-shaped and reads:

* `GET /projects/{id}/sessions` — `main` | `plan` | `worker:<run_id>` | `system`, with
  `tokens {input,cache_read,output}`, `live`, `counts`, `duration_ms`, `model`.
* `GET /projects/{id}/sessions/{key}/activities?before&limit` — reverse-paginated rows:
  `thinking`, `tool_call`, `tool_result`, `message`, `error`, `status`; tool rows carry
  `{name, call_id, input, output, duration_ms, is_error}`.
* `GET /projects/{id}/sessions/stream?since` — optional SSE (`event: activity`).

`src/lib/cairn-sessions.ts` falls back to `/projects/{id}/workers` + `/chat/conversations`
when the sessions endpoints are unavailable, so older engines still render.

The domain layer (`Test assets`, `Asset coverage`, `Retests`, first-class `Findings`) reads
the additive fields on `GET /projects/{id}` — `entities`, `findings`, `retests`, `coverage` —
plus `/projects/{id}/entities`, `/findings`, `/findings/{id}/retests`, `/retests/{id}`,
`/coverage` and `/coverage/graph`. Types and calls live in `src/lib/cairn-api.ts`; the full
contract is [`../docs/DOMAIN-LAYER.md`](../docs/DOMAIN-LAYER.md). Tabs are
data-driven: assets/coverage/retests appear only when their arrays are non-empty, and
first-class findings replace the derived fact list only when `detail.findings` has rows.

## Editing notes (learned the hard way)

* **Do not serve the public domain from `next dev`.** The dev overlay turns React
  development warnings into a full-screen error page. Production build only.
* The theme boot script must stay an inline `<script>` (`src/scripts/theme-boot.tsx`).
  `next/script` from a nested server component resolves to a lazy promise in this Next 16
  build and crashes the client with *"Element type is invalid"*. The inline form's React
  warning is development-only.
* After long dev-server uptime, webpack can serve a stale graph; restart it before
  debugging anything that smells like a bogus module error.
* `conversations-tab.tsx` is a thin wrapper around `sessions-view.tsx`. Keep the Artex
  structure (292 px rail, section order, live badges, tool ticks, stick-to-bottom) when
  changing it; the reference screenshots are in the research archive's history.
