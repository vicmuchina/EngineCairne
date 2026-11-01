// Centralised status → color/label semantics, reused across the whole app.
// Spec section 8.3: intent / coverage / task / severity each have a consistent color set.

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "rose" | "violet" | "slate";

export const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20",
  // rose is used for "critical" -- a solid, high-emphasis fill that reads clearly above the soft red outline of "high".
  rose: "bg-rose-600 text-white border-rose-600 dark:bg-rose-600 dark:text-white",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20",
  slate: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
};

export const toneDot: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  rose: "bg-white",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

interface StatusMeta {
  label: string;
  tone: Tone;
}

const intent: Record<string, StatusMeta> = {
  open: { label: "Unclaimed", tone: "slate" },
  running: { label: "Executing", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  done: { label: "Done", tone: "green" },
  // blocked = a model/API/network failure exhausted the retries, so this intent was never really explored (not a target-side block).
  blocked: { label: "Execution error", tone: "red" },
  // exhausted = cut short on the step/time budget, writing back only partial results (not "the direction was fully explored").
  exhausted: { label: "Budget exhausted", tone: "violet" },
  // stopped = a legacy soft-delete state (kept for historical data).
  stopped: { label: "Stopped", tone: "slate" },
  // deleted = the user soft-deleted this intent (the node and its lineage are kept; the reason is in the delete_reason field).
  deleted: { label: "Deleted", tone: "slate" },
};

const task: Record<string, StatusMeta> = {
  created: { label: "Created", tone: "slate" },
  queued: { label: "Queued", tone: "amber" },
  running: { label: "Running", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  done: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  timeout: { label: "Timed out", tone: "amber" },
};

const severity: Record<string, StatusMeta> = {
  critical: { label: "Critical", tone: "rose" },
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "slate" },
};

const finding: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "amber" },
  in_progress: { label: "In progress", tone: "blue" },
  confirmed: { label: "Confirmed", tone: "red" },
  resolved: { label: "Handled", tone: "green" },
  fixed: { label: "Fixed", tone: "green" },
  false_positive: { label: "False positive", tone: "slate" },
  ignored: { label: "Ignored", tone: "neutral" },
  duplicate: { label: "Duplicate", tone: "neutral" },
  risk_accepted: { label: "Risk accepted", tone: "violet" },
};

const engine: Record<string, StatusMeta> = {
  exploring: { label: "Exploring", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  stalled: { label: "Stalled", tone: "red" },
  idle: { label: "Idle", tone: "neutral" },
};

const goal: Record<string, StatusMeta> = {
  open: { label: "In progress", tone: "blue" },
  met: { label: "Met", tone: "green" },
  abandoned: { label: "Abandoned", tone: "slate" },
};

const audit: Record<string, StatusMeta> = {
  allow: { label: "Allowed", tone: "green" },
  block: { label: "Intercepted", tone: "red" },
};

// Cairn project lifecycle (GET /projects: active | stopped | completed).
const project: Record<string, StatusMeta> = {
  active: { label: "Active", tone: "green" },
  stopped: { label: "Stopped", tone: "amber" },
  completed: { label: "Completed", tone: "blue" },
};

// Cairn intents have no status column; state is derived from worker/concluded_at.
const cairnIntent: Record<string, StatusMeta> = {
  working: { label: "Working", tone: "blue" },
  unclaimed: { label: "Unclaimed", tone: "slate" },
  concluded: { label: "Concluded", tone: "green" },
};

// Runtime v2 unified feed statuses (facts/intents/hints/tools/chat/approvals).
const cairnFeed: Record<string, StatusMeta> = {
  confirmed: { label: "Confirmed", tone: "green" },
  concluded: { label: "Concluded", tone: "green" },
  working: { label: "Working", tone: "blue" },
  open: { label: "Open", tone: "slate" },
  added: { label: "Added", tone: "violet" },
  pending: { label: "Pending", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  denied: { label: "Denied", tone: "red" },
  expired: { label: "Expired", tone: "slate" },
  cancelled: { label: "Cancelled", tone: "slate" },
  running: { label: "Running", tone: "blue" },
  streaming: { label: "Streaming", tone: "blue" },
  done: { label: "Done", tone: "green" },
  stopped: { label: "Stopped", tone: "slate" },
  active: { label: "Active", tone: "green" },
  error: { label: "Error", tone: "red" },
  idle: { label: "Idle", tone: "neutral" },
  info: { label: "Info", tone: "neutral" },
  unknown: { label: "Unknown", tone: "neutral" },
};

// Dispatcher worker-run lifecycle (GET /projects/{id}/workers).
const worker: Record<string, StatusMeta> = {
  running: { label: "Running", tone: "blue" },
  streaming: { label: "Streaming", tone: "blue" },
  success: { label: "Completed", tone: "green" },
  done: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  timeout: { label: "Timed out", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "slate" },
  error: { label: "Error", tone: "red" },
  stopped: { label: "Stopped", tone: "slate" },
  stale: { label: "Stale", tone: "amber" },
  unknown: { label: "Unknown", tone: "neutral" },
};

// Derived Cairn activity events (claims, conclusions, recorded facts, hints).
const activity: Record<string, StatusMeta> = {
  claimed: { label: "Claimed", tone: "blue" },
  concluded: { label: "Concluded", tone: "green" },
  unclaimed: { label: "Unclaimed", tone: "slate" },
  recorded: { label: "Recorded", tone: "amber" },
  curator: { label: "Curator", tone: "violet" },
};

const node: Record<string, StatusMeta> = {
  observed: { label: "Observed", tone: "slate" },
  confirmed: { label: "Confirmed", tone: "green" },
  tombstoned: { label: "Retired", tone: "neutral" },
};

// Notification delivery status. sending uses blue rather than amber: it does not mean "something is wrong"
// but "claimed and being sent", which has to read differently from pending's "waiting".
const delivery: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "amber" },
  sending: { label: "Sending", tone: "blue" },
  sent: { label: "Delivered", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const maps = {
  intent,
  task,
  severity,
  finding,
  engine,
  goal,
  project,
  cairnIntent,
  cairnFeed,
  worker,
  activity,
  audit,
  node,
  delivery,
} as const;

export type StatusDomain = keyof typeof maps;

export function statusMeta(domain: StatusDomain, key: string): StatusMeta {
  return maps[domain][key] ?? { label: key, tone: "neutral" };
}
