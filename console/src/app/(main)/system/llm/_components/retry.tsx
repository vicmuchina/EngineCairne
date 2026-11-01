"use client";

// The shared pieces of the LLM retry configuration: the "count + interval" of each of the five layers.
//
// The five layers from the inside out: connect (SDK) -> empty response (SDK) -> the same-provider safety window -> the round-robin breaker -> intent rerun.
// The first three follow the endpoint, so every model configuration can override the global default; the last two are process-level and exist once, globally.
//
// Every input follows the same "empty = not configured" semantics as the backend's db.RetryRule:
//   count     empty/0 = use the built-in default | -1 = turn this layer off | >0 = use this count
//   interval  empty/0 = use this layer's own exponential backoff | >0 = use this fixed interval in milliseconds

import * as React from "react";

import { Loader2Icon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { LLMRetryOverride, LLMRetryPolicy, LLMRetryRule } from "@/lib/types";

export const ZERO_RULE: LLMRetryRule = { attempts: 0, interval_ms: 0 };
export const ZERO_OVERRIDE: LLMRetryOverride = {
  connect: ZERO_RULE,
  empty: ZERO_RULE,
  stream: ZERO_RULE,
};
const ZERO_POLICY: LLMRetryPolicy = {
  ...ZERO_OVERRIDE,
  breaker: ZERO_RULE,
  intent: ZERO_RULE,
};

type LayerMeta = {
  title: string;
  /** Where this retry layer happens and who performs it */
  where: string;
  /** What kind of error reaches this layer -- named down to the status code, so nobody has to guess */
  trigger: string;
  /** Errors that look similar but do **not** reach this layer, so a knob that seems to do nothing is not mistaken for a bug */
  skips?: string;
  desc: string;
  attemptsLabel: string;
  /** The default used when the count is left empty, for the placeholder */
  defAttempts: number;
  /** The default strategy when the interval is left empty, for the placeholder */
  defInterval: string;
  /** What -1 means for the count */
  offHint: string;
};

export const RETRY_LAYERS = {
  connect: {
    title: "Connect retries",
    where: "SDK - before a 200 is received",
    trigger:
      "It cannot connect or has not got a 200 yet: a connection reset / a read or write timeout / a DNS failure and other network-layer errors, plus HTTP 408, 429, 500, 502, 503 and 504.",
    skips: "Every other status code (400 / 401 / 403 / 404 / 413 / 422 and so on) is a deterministic refusal that would fail the same way again, so it is raised straight away.",
    desc: "Resends the identical request. Once the stream has started (a 200 is already in hand), a mid-stream disconnect is no longer this layer's business.",
    attemptsLabel: "Retry count",
    defAttempts: 3,
    defInterval: "0.5s->1s->2s exponential (capped at 8s)",
    offHint: "-1 = never retry; a failure is raised immediately",
  },
  empty: {
    title: "Empty-response retries",
    where: "SDK - the openai format only",
    trigger:
      "HTTP 200 with a normal stop finish_reason, but the whole response holds not one content block -- an empty gateway frame, a dropped thinking frame or a sampling hiccup all look like this.",
    skips: "Having no content because max_tokens truncated it does not count (that is solved by raising the output cap; resending would just hit it again).",
    desc: "Resends the whole prompt, so it is expensive on a long context and the count should stay small.",
    attemptsLabel: "Retry count",
    defAttempts: 2,
    defInterval: "0.5s->1s->2s exponential (capped at 8s)",
    offHint: "-1 = hand an empty response straight back",
  },
  stream: {
    title: "Same-provider safety-window retries",
    where: "This project - before any output is delivered",
    trigger:
      "Something went wrong after the stream was established (a 200 is in hand): the connection dropped mid-stream, the provider is overloaded, or a 429 / 5xx error event arrived inside the stream -- and not one token has reached the caller yet.",
    skips:
      "An exhausted quota (402 / insufficient_quota, left to the round-robin to switch configurations), a context that is too long (413 / context length, left to compaction) and the deterministic refusals 400 / 401 / 403 / 404 / 422 are never retried.",
    desc: "Replays the same request on the same configuration. Because no output has been delivered, the replay cannot repeat model output or a tool execution.",
    attemptsLabel: "Retry count",
    defAttempts: 2,
    defInterval: "0.5s->1s exponential (capped at 4s)",
    offHint: "-1 = hand a broken stream straight to the outer intent rerun",
  },
  breaker: {
    title: "Round-robin breaker",
    where: "This project - process-level, one global instance",
    trigger:
      "It trips when transient failures (429, 5xx, network errors) accumulate consecutively to the threshold; a deterministic failure such as being out of credit (402), an invalid key (401 / 403) or a missing model (404) ignores the threshold and trips on the first one.",
    skips: "One success resets it to zero, so a configuration that hiccups occasionally is never slowly accumulated into a trip.",
    desc: "Once tripped it enters a cooldown, during which the round-robin skips that configuration outright. The state is persisted and survives a restart.",
    attemptsLabel: "Consecutive failures before tripping",
    defAttempts: 3,
    defInterval: "1min->5min->30min steps",
    offHint: "-1 = a transient failure never trips it (a deterministic failure still does)",
  },
  intent: {
    title: "Intent rerun",
    where: "This project - process-level, one global instance",
    trigger:
      "None of the layers before it caught it: the worker ended with model_error -- either every inner retry was used up, or the stream broke after it had started delivering output (at which point a replay is unsafe and the whole thing has to start over).",
    skips: "An exhausted quota is already handled by the round-robin switching configurations and is not rerun here; when the task is paused, terminated or entering its wrap-up it yields immediately rather than holding up the backoff.",
    desc: "Runs the whole intent again from the start. It is the outermost layer, so one rerun multiplies the counts of every layer inside it again.",
    attemptsLabel: "Rerun count",
    defAttempts: 2,
    defInterval: "a fixed 3s",
    offHint: "-1 = no rerun; the intent is judged blocked outright",
  },
} satisfies Record<string, LayerMeta>;

type LayerKey = keyof typeof RETRY_LAYERS;

/** Milliseconds in plain words, shown beside the input box only so nobody has to count zeros. */
function humanMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(2))}s`;
  return `${Number((ms / 60_000).toFixed(2))}min`;
}

/** A controlled number input: an empty string <-> 0, while an intermediate state ("-", "1e") stays local and never bothers the parent. */
function NumField({
  id,
  value,
  onChange,
  placeholder,
  min,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  placeholder: string;
  min: number;
}) {
  const [text, setText] = React.useState(value === 0 ? "" : String(value));
  // Follow the parent when it swaps in a whole new set of values (reading the policy, switching configurations); typing never reaches here,
  // because by then value already equals the parsed local text.
  React.useEffect(() => {
    const incoming = value === 0 ? "" : String(value);
    setText((cur) => (Number(cur || 0) === value ? cur : incoming));
  }, [value]);
  return (
    <Input
      id={id}
      type="number"
      min={min}
      className="w-28 shrink-0"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onChange(e.target.value.trim() === "" || !Number.isFinite(n) ? 0 : Math.trunc(n));
      }}
    />
  );
}

/** The two knobs of one retry layer. idPrefix keeps the label's htmlFor valid when it appears several times on one page. */
export function RetryRuleFields({
  layer,
  idPrefix,
  value,
  onChange,
  compact,
}: {
  layer: LayerKey;
  idPrefix: string;
  value: LLMRetryRule;
  onChange: (r: LLMRetryRule) => void;
  /** true = the compact version inside the configuration drawer: the expanded explanation is dropped and only "what errors reach this layer" is kept */
  compact?: boolean;
}) {
  const meta = RETRY_LAYERS[layer];
  const human = humanMs(value.interval_ms);
  return (
    <div className={compact ? "grid gap-2" : "grid gap-3 rounded-lg border p-3"}>
      <div className="grid gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <Label className="text-sm">{meta.title}</Label>
          <span className="text-muted-foreground text-xs">{meta.where}</span>
        </div>
        {/* Which errors reach this layer, down to the status code -- a knob that was set but seems to do nothing usually means the error never lands in this layer. */}
        <p className="text-muted-foreground text-xs">
          <span className="font-medium text-foreground">Triggered by</span>: {meta.trigger}
        </p>
        {!compact && meta.skips && (
          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">Does not reach this layer</span>: {meta.skips}
          </p>
        )}
        {!compact && <p className="text-muted-foreground text-xs">{meta.desc}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-n`} className="text-muted-foreground text-xs">
            {meta.attemptsLabel}
          </Label>
          <NumField
            id={`${idPrefix}-${layer}-n`}
            min={-1}
            value={value.attempts}
            placeholder={`default ${meta.defAttempts}`}
            onChange={(n) => onChange({ ...value, attempts: n })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-ms`} className="text-muted-foreground text-xs">
            Interval ms
          </Label>
          <NumField
            id={`${idPrefix}-${layer}-ms`}
            min={0}
            value={value.interval_ms}
            placeholder="default backoff"
            onChange={(n) => onChange({ ...value, interval_ms: n })}
          />
          <span className="text-muted-foreground text-xs">{human ? `a fixed ${human}` : meta.defInterval}</span>
        </div>
      </div>
      {!compact && <p className="text-muted-foreground text-xs">Empty = use the default; {meta.offHint}.</p>}
    </div>
  );
}

/** The three overrides in the model configuration drawer (the three layers that follow the endpoint). */
export function ProfileRetryFields({
  value,
  onChange,
}: {
  value: LLMRetryOverride;
  onChange: (o: LLMRetryOverride) => void;
}) {
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-0.5">
        <Label className="text-sm">Retry overrides</Label>
        <p className="text-muted-foreground text-xs">
          They apply to this configuration only and override the global defaults under "Retries and backoff". Leaving a box empty follows the global value; a count of -1 turns that layer off;
          setting an interval replaces the exponential backoff with that fixed interval. The breaker and the intent rerun are process-level and can only be changed on the global page.
        </p>
      </div>
      {(["connect", "empty", "stream"] as const).map((k) => (
        <div key={k} className="border-t pt-3 first:border-t-0 first:pt-0">
          <RetryRuleFields
            compact
            layer={k}
            idPrefix="pf"
            value={value[k]}
            onChange={(r) => onChange({ ...value, [k]: r })}
          />
        </div>
      ))}
    </div>
  );
}

/** The "Retries and backoff" tab: the global defaults of the five layers. */
export function RetryPolicyPanel() {
  const [policy, setPolicy] = React.useState<LLMRetryPolicy>(ZERO_POLICY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.llmRetryPolicy();
      setPolicy({ ...ZERO_POLICY, ...p });
    } catch (e) {
      toast.error(`Reading the retry policy failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // The backend clamps an out-of-range value back into its range and returns it, so refreshing from the returned value makes what you see what is stored.
      const saved = await api.saveLLMRetryPolicy(policy);
      setPolicy({ ...ZERO_POLICY, ...saved });
      toast.success("Saved and applied immediately (the call currently in flight still uses the old parameters)");
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const set = (k: LayerKey) => (r: LLMRetryRule) => setPolicy((p) => ({ ...p, [k]: r }));

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-10 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" /> Reading the retry policy...
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs leading-relaxed">
        One failed model call passes through five retry layers in turn, from the inside out:
        <span className="text-foreground"> connect -&gt; empty response -&gt; the same-provider safety window -&gt; the round-robin breaker -&gt; intent rerun</span>
        . An outer layer only gets its turn once the inner one is exhausted, so the counts
        <span className="text-foreground"> multiply</span>
        -- max out every layer and one hiccup can burn dozens of requests.
        Leaving everything empty gives the current defaults, exactly the behaviour of not having this page at all. The first three layers can be overridden in each model configuration.
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(Object.keys(RETRY_LAYERS) as LayerKey[]).map((k) => (
          <RetryRuleFields key={k} layer={k} idPrefix="gl" value={policy[k]} onChange={set(k)} />
        ))}
      </div>

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
          Save
        </Button>
        <Button variant="outline" onClick={() => setPolicy(ZERO_POLICY)} disabled={saving}>
          Restore every default
        </Button>
      </div>
    </div>
  );
}
