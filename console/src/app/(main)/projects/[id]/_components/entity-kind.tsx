"use client";

import {
  AppWindowIcon,
  BoxesIcon,
  BrainIcon,
  CogIcon,
  DatabaseIcon,
  FileIcon,
  FunctionSquareIcon,
  GlobeIcon,
  LinkIcon,
  type LucideIcon,
  NetworkIcon,
  ServerIcon,
  WaypointsIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Entity kinds are free strings. Known kinds get a small icon; anything else
 * gets a generic icon plus a colour derived from a stable hash of the string,
 * so a new worker-defined kind still looks deliberate instead of unstyled.
 */
const KIND_ICONS: Record<string, LucideIcon> = {
  host: ServerIcon,
  url: LinkIcon,
  ip: NetworkIcon,
  subdomain: GlobeIcon,
  endpoint: WaypointsIcon,
  service: CogIcon,
  app: AppWindowIcon,
  file: FileIcon,
  function: FunctionSquareIcon,
  dataset: DatabaseIcon,
  model: BrainIcon,
};

function hashCode(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface KindColor {
  /** Solid colour for dots, icons and graph nodes. */
  hex: string;
  /** Tinted chip/segment background. */
  soft: string;
  border: string;
}

export function kindColor(kind: string): KindColor {
  const hue = hashCode(kind.toLowerCase()) % 360;
  return {
    hex: `hsl(${hue} 62% 47%)`,
    soft: `hsl(${hue} 70% 50% / 0.14)`,
    border: `hsl(${hue} 62% 47% / 0.36)`,
  };
}

export function kindLabel(kind: string): string {
  const text = kind.replace(/[_-]+/g, " ").trim();
  if (!text) return "unknown";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind.toLowerCase()] ?? BoxesIcon;
}

export function KindDot({ kind, className }: { kind: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: kindColor(kind).hex }}
    />
  );
}

export function KindMark({ kind, className }: { kind: string; className?: string }) {
  const Icon = kindIcon(kind);
  return <Icon aria-hidden className={cn("size-3 shrink-0", className)} style={{ color: kindColor(kind).hex }} />;
}

export function KindBadge({ kind, count, className }: { kind: string; count?: number; className?: string }) {
  const color = kindColor(kind);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-foreground",
        className,
      )}
      style={{ backgroundColor: color.soft, borderColor: color.border }}
      title={kind}
    >
      <KindMark kind={kind} />
      <span className="truncate">{kindLabel(kind)}</span>
      {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
    </span>
  );
}
