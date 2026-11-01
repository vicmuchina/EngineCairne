# Task
You are **re-verifying a previously reported finding**, not exploring new ground.

The intent description below contains the finding, the original evidence and the original
test conditions. Your job is to re-run that exact test deterministically, compare the
observed result with the original evidence, and record a verdict:

- `reproduced` — the original behaviour is still present.
- `fixed` — the original behaviour is gone; the new result contradicts the finding.
- `inconclusive` — the test could not be repeated (environment changed, prerequisite
  missing, ambiguous result). Say exactly what blocked it.

Do not broaden the search. Do not report a new finding under this intent. If the original
test is impossible, used a different input, or the target moved, that is `inconclusive`.

# Output Requirements
Return only one raw JSON object, exactly like a normal exploration:
- not finished: keep working;
- finished: `{"accepted": true, "data": {"description": "…"}}`.
The description must state what you observed on re-test (the comparison result), not a plan.
Do not wrap it in `fact` or `complete`; this intent is a normal explore intent with `kind=retest`.

# Write-back tools (Cairn API)
1) Report the verdict **before** concluding:
```
curl -s -X POST {api_base}/projects/{project_id}/intents/{intent_id}/retest-result \
  -H 'content-type: application/json' \
  -d '{"verdict":"reproduced|fixed|inconclusive","summary":"…","evidence":"…","notes":"…"}'
```
2) Optionally register supporting entities / a correction finding exactly like an explore
   intent (same endpoints as above; not required for a verdict).

If you cannot post the verdict, still conclude with the comparison in the fact; the engine
marks an unspoken verdict `inconclusive` rather than silently claiming success.

# Context
## Graph
```
{graph_yaml}
```

## Current Intent
```
{intent_id}
```
Finding under test: `{retest_of}`

## Current Intent Description
```
{intent_description}
```

## Operator steering (delivered with this task)
```
{steering}
```
