# Cairn domain layer

Cairn's core is a fact graph: **facts** are what is known, **intents** are what is being
tested, **hints** are operator constraints. The domain layer adds four optional objects on
top of that core **without changing it**:

| Object | Meaning | Backing store |
| --- | --- | --- |
| **Entity** | a typed referent (host, endpoint, file, dataset, model, symbol, …) | `entities`, `entity_facts`, `entity_intents` |
| **Finding** | a claim backed by a fact (severity/class/status) | `findings`, `finding_entities` |
| **Retest** | an intent that re-runs a finding's original test | `intents.kind='retest'`, `intents.retest_of`, `finding_retests` |
| **Coverage** | tested vs in-scope entities, derived — never stored | SQL projection over entities × facts/intents |

Everything is **additive and data driven**. There are no profiles, no "pentest mode", and no
project classification. A project that only has facts renders exactly the seven Artex tabs it
always had; a project with entities or findings grows the matching tabs. Empty tabs are never
shown.

## Design rules

1. **Generalize the semantics, not the labels.** `kind`, `klass` and `severity` are free-form
   strings. Any domain that has assets (entities), evidence-backed claims (findings) and
   re-verification (retests) gets the same mechanics.
2. **Findings are a projection of facts.** A finding stores `fact_id` plus presentation
   metadata; it never duplicates the evidence row. Deleting the fact leaves the finding
   orphan-safe (FKs are nullable).
3. **Retests are intents.** `kind='retest'` with `retest_of=<finding id>` reuses the dispatcher,
   worker containers, transcripts, approvals, usage accounting and sessions UI unchanged.
4. **Coverage is derived.** `tested = entities anchored to a fact OR to a concluded intent`;
   `denominator = in-scope entities ∪ anchored entities`. In-scope is sticky: a later worker
   write cannot silently un-scope an asset.
5. **Retest verdicts are sealed.** Once a retest is `completed|failed|stopped`, later
   `retest-result` posts cannot overwrite it. A conclude without a posted verdict becomes
   `inconclusive`, never a silent success.

## Data model

```sql
entities(id, project_id, kind, key, label, parent_id, in_scope, status, source,
         metadata, created_at, last_seen_at)
         UNIQUE(project_id, kind, key)

entity_facts(entity_id, project_id, fact_id)          -- explicit evidence anchors
entity_intents(entity_id, project_id, intent_id)      -- "examined during" anchors

findings(id, project_id, fact_id, intent_id, entity_id, title, klass, severity,
         summary, evidence, status, worker, metadata, report, created_at, updated_at)

finding_entities(finding_id, entity_id)
finding_retests(finding_id, retest_id)

intents.kind        -- 'explore' (default) or 'retest'
intents.retest_of   -- finding id for retest intents
```

Finding statuses: `pending`, `in_progress`, `confirmed`, `resolved`, `fixed`,
`false_positive`, `ignored`, `duplicate`, `risk_accepted`.
Retest statuses: `pending`, `running`, `completed`, `failed`, `stopped`.
Verdicts: `reproduced`, `fixed`, `inconclusive` (`reproduced → finding confirmed`,
`fixed → finding fixed`, `inconclusive → finding untouched`).

At most one active retest per finding is enforced by a partial unique index
(`status IN ('pending','running')`), matching Artex's dedupe behaviour.

## API

All endpoints are project-scoped and additive to `GET /projects/{id}` (which now also returns
`entities`, `findings`, `retests`, `coverage`).

```
GET    /projects/{id}/entities                  ?kind=&q=&in_scope=&tested=&limit=
POST   /projects/{id}/entities                  batch upsert
POST   /projects/{id}/entity                    single upsert  {kind,key,label,parent_id,in_scope,intent_id,facts}
PATCH  /projects/{id}/entities/{eid}            in_scope / status / label / metadata
POST   /projects/{id}/entities/{eid}/facts?fact_id=

GET    /projects/{id}/findings                  ?status=&severity=&entity_id=
POST   /projects/{id}/findings                  {title,summary,evidence,fact_id,entities[],severity,klass}
PATCH  /projects/{id}/findings/{fid}            status / severity / klass / title / summary / evidence / report

GET    /projects/{id}/findings/{fid}/retests
POST   /projects/{id}/findings/{fid}/retests    {notes?,worker?}  -> creates pending intent + retest
PATCH  /projects/{id}/retests/{rid}             verdict / notes / status / summary / evidence
POST   /projects/{id}/intents/{iid}/retest-result   {verdict,summary,evidence,notes}

GET    /projects/{id}/coverage                  {tested,denominator,pct,scope_rows,by_kind,untested}
GET    /projects/{id}/coverage/graph            {nodes[],edges[]} for the containment graph
```

Prompts receive `{api_base}`, `{project_id}` and `{intent_id}` and write back with `curl`;
`explore.md`, `bootstrap.md` and `reason.md` document the entity/finding calls, and
`reason.md` gets a `{scope}` block so the planner sees coverage instead of guessing.
`retest.md` drives the retest worker (reproduce the original probe, post a verdict, then
conclude).

## UI

Two tabs were added to the Artex tab set; both are conditional on data:

- **Test assets** — header counts (`entities · tested/in-scope · in scope`), kind filter chips
  with hashed colours for unknown kinds, search, `In scope only` / `Untested` toggles, table
  `Label | Kind | Key | Tested | In scope | Source | Facts | Last seen`, a detail drawer with
  facts/findings and `Open in graph`, and an **Add entity** dialog. Kinds are free strings.
- **Asset coverage** — percentage header, per-kind stacked bar, `@xyflow/react` containment
  graph (`parent_id`), tested nodes ringed, untested dashed, out-of-scope muted, minimap,
  drawer, 300-node cap.

First-class **Findings** replace the fact-derived list whenever `detail.findings` is non-empty
(legacy projects keep the derived view). Rows expand to summary, evidence, report, entity
chips, an inline disposition `Select` (`PATCH …/findings/{id}`), **Open fact in graph** and
**Retests**.

The **Retests** tab is a two-column Artex-parity page: searchable finding picker with
severity/status badges and a running spinner, finding header with class and linked entities,
retest history accordion (status/verdict badges, relative time, summary, notes, evidence,
error, run id), and a **Start a retest** dialog with 4000-character notes. It polls only while
a retest is `pending|running`, disables creation while one is active, and says
**Project completed** when the project is `completed` (no dispatcher to run it).

The Overview gains a **Scope & coverage** card (percentage, tested/scope rows, kind chips,
untested sample) and a first-class `Findings` stat; the Broadcast board gains
`Entity / Finding / Retest` chips; the Report gains `Scope and coverage`, `Findings` and
`Retests` sections plus `Recorded findings` and `Entities` metrics.

## Tests

```bash
cd cairn
.venv/bin/python -m pytest -q            # 243 passed
```

`tests/test_domain_layer.py` covers: duplicate upsert, out-of-scope coverage, sticky scope,
finding + retest lifecycle, inconclusive fallback, detail/report sections, and concluded-intent
anchoring. `tests/test_report.py` asserts the renamed `## Confirmed facts` heading.

Manual smoke (server on `:8000`, web on `:3001`):

```bash
curl -s -X POST localhost:8000/projects -H 'content-type: application/json' \
  -d '{"title":"demo","origin":"…","goal":"…","bootstrap_enabled":false}'
# create entity, conclude a fact, create finding, POST retest, watch /retests until completed
```

## Artex parity notes

Shared semantics: entity containment, in-scope/total coverage, finding picker + retest history,
verdict wording (`Still reproducible`, `Fixed`, `Cannot be confirmed`, `Waiting to start`,
`Retesting`, `Done`), one active retest per finding, polling only while active, notes capped at
4000 characters, evidence collapsed by default.

Deliberate differences: Cairn exposes **no profiles**, keeps retests inside the generic intent
dispatcher (so they appear in Conversations and Sessions), derives coverage from the graph
rather than a separate asset table, and never fakes a percentage when the denominator is zero
(`pct` is `null` and the UI prints `—`).
