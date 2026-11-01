/**
 * Small display helpers for Cairn data. Kept separate from cairn-api.ts so the
 * API module stays transport-only.
 */

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}

export function formatRelative(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** One-line, whitespace-collapsed description for list rows. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Shorten an identifier (facts are origin/goal/f001…; intents i001…). */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

/** Numeric suffix of a fact/intent id, used to sort newest-first. */
export function idOrdinal(id: string): number {
  const match = id.match(/(\d+)$/);
  return match ? Number(match[1]) : -1;
}

/** `1 project` / `2 projects`, with the number formatted. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
