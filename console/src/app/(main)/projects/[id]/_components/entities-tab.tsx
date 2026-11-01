"use client";

import * as React from "react";

import {
  CheckIcon,
  ExternalLinkIcon,
  FilterIcon,
  NetworkIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  TagsIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Entity, Finding, ProjectDetail } from "@/lib/cairn-api";
import { cairn } from "@/lib/cairn-api";
import { formatNumber, formatRelative, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

import { KindBadge, KindDot, kindLabel } from "./entity-kind";

const ROW_LIMIT = 200;

function testedBadge(tested: boolean) {
  return tested ? (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/40 bg-emerald-500/10 py-0 text-[10px] text-emerald-700 dark:text-emerald-400"
    >
      <CheckIcon className="size-3" />
      Tested
    </Badge>
  ) : (
    <Badge variant="outline" className="border-dashed py-0 text-[10px] text-muted-foreground">
      Untested
    </Badge>
  );
}

function scopeBadge(inScope: boolean) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "py-0 text-[10px]",
        inScope
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
          : "border-dashed text-muted-foreground",
      )}
    >
      {inScope ? "In scope" : "Out of scope"}
    </Badge>
  );
}

function linkedFactIds(entity: Entity, findings: Finding[]): string[] {
  const ids = new Set<string>();
  for (const factId of entity.facts ?? []) if (factId) ids.add(factId);
  for (const finding of findings) if (finding.fact_id) ids.add(finding.fact_id);
  return [...ids];
}

function EntityDrawer({
  projectId,
  entity,
  entities,
  findings,
  open,
  onOpenChange,
  onRefresh,
  onOpenGraph,
  onOpenFindings,
}: {
  projectId: string;
  entity: Entity | null;
  entities: Entity[];
  findings: Finding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void>;
  onOpenGraph: (nodeId: string) => void;
  onOpenFindings: (entityId: string) => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const entityFindings = React.useMemo(
    () =>
      entity
        ? findings.filter((finding) => finding.entity_id === entity.id || finding.entity_ids.includes(entity.id))
        : [],
    [entity, findings],
  );
  const factIds = entity ? linkedFactIds(entity, entityFindings) : [];
  const parent = entity?.parent_id ? entities.find((item) => item.id === entity.parent_id) : null;

  const toggleScope = async (checked: boolean) => {
    if (!entity) return;
    setSaving(true);
    try {
      await cairn.patchEntity(projectId, entity.id, { in_scope: checked });
      toast.success(checked ? "Entity marked in scope" : "Entity moved out of scope");
      await onRefresh();
    } catch (cause) {
      toast.error("Could not update the entity scope", { description: (cause as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {!entity ? (
          <div className="p-6 text-sm text-muted-foreground">Entity not found.</div>
        ) : (
          <>
            <SheetHeader className="border-b px-5 py-4 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <KindBadge kind={entity.kind} />
                {testedBadge(entity.tested)}
                {scopeBadge(entity.in_scope)}
              </div>
              <SheetTitle className="mt-1 break-words text-base">{entity.label || entity.key}</SheetTitle>
              <SheetDescription className="break-all font-mono text-[11px]">
                {entity.id} · {entity.key}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-5 px-5 py-4 text-xs">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Full key</div>
                  <div className="mt-0.5 break-all font-mono text-[11px]">{entity.key}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Parent</div>
                  <div className="mt-0.5">
                    {parent ? (
                      <span className="font-mono text-[11px]">
                        {parent.label || parent.key} <span className="text-muted-foreground">({parent.id})</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Root entity</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</div>
                  <div className="mt-0.5 capitalize">{entity.status || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</div>
                  <div className="mt-0.5">{entity.source || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">First seen</div>
                  <div className="mt-0.5" suppressHydrationWarning>
                    {formatRelative(entity.created_at)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last seen</div>
                  <div className="mt-0.5" suppressHydrationWarning>
                    {formatRelative(entity.last_seen_at)}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <FilterIcon className="size-3.5 text-muted-foreground" />
                  <div>
                    <div className="font-medium">In scope</div>
                    <div className="text-[10px] text-muted-foreground">
                      Out-of-scope entities are context only and excluded from coverage.
                    </div>
                  </div>
                </div>
                <Switch
                  checked={entity.in_scope}
                  disabled={saving}
                  onCheckedChange={(checked) => void toggleScope(checked)}
                  aria-label="Toggle entity scope"
                />
              </div>

              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Metadata
                </h3>
                {Object.keys(entity.metadata ?? {}).length > 0 ? (
                  <pre className="max-h-48 overflow-auto rounded-md border bg-muted/20 p-2.5 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(entity.metadata, null, 2)}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">No metadata recorded.</p>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Linked facts</span>
                  <span className="font-normal normal-case tracking-normal">{formatNumber(entity.fact_count)}</span>
                </h3>
                {factIds.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {factIds.map((factId) => (
                      <button
                        key={factId}
                        type="button"
                        onClick={() => {
                          onOpenGraph(factId);
                          onOpenChange(false);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border bg-muted/20 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                        title={`Open ${factId} in the exploration graph`}
                      >
                        {factId}
                        <NetworkIcon className="size-3 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                ) : entity.fact_count > 0 ? (
                  <p className="text-muted-foreground">
                    {formatNumber(entity.fact_count)} linked fact{entity.fact_count === 1 ? "" : "s"} recorded. This
                    engine does not expose their ids on the entity detail contract.
                  </p>
                ) : (
                  <p className="text-muted-foreground">No facts linked yet.</p>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Findings on this entity</span>
                  <span className="font-normal normal-case tracking-normal">{entityFindings.length}</span>
                </h3>
                {entityFindings.length > 0 ? (
                  <div className="divide-y rounded-md border">
                    {entityFindings.map((finding) => (
                      <div key={finding.id} className="flex items-start gap-2 px-3 py-2">
                        <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 font-medium text-foreground/90">
                            {oneLine(finding.title || finding.summary || finding.id)}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">{finding.id}</span>
                            {finding.severity && <span className="capitalize">{finding.severity}</span>}
                            <span className="capitalize">{finding.status.replace(/[_-]/g, " ")}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onOpenFindings(entity.id);
                          onOpenChange(false);
                        }}
                      >
                        <ExternalLinkIcon data-icon="inline-start" />
                        Open Findings
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No findings linked to this entity.</p>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AddEntityDialog({
  projectId,
  entities,
  open,
  onOpenChange,
  onRefresh,
}: {
  projectId: string;
  entities: Entity[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [kind, setKind] = React.useState("host");
  const [key, setKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [parentId, setParentId] = React.useState("none");
  const [inScope, setInScope] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const reset = () => {
    setKind("host");
    setKey("");
    setLabel("");
    setParentId("none");
    setInScope(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!kind.trim() || !key.trim()) {
      toast.error("Kind and key are required");
      return;
    }
    setSaving(true);
    try {
      await cairn.upsertEntity(projectId, {
        kind: kind.trim(),
        key: key.trim(),
        label: label.trim(),
        parent_id: parentId === "none" ? null : parentId,
        in_scope: inScope,
      });
      toast.success("Entity registered", { description: `${kind.trim()} · ${key.trim()}` });
      await onRefresh();
      reset();
      onOpenChange(false);
    } catch (cause) {
      toast.error("Could not register the entity", { description: (cause as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const parents = React.useMemo(
    () => [...entities].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)),
    [entities],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add entity</DialogTitle>
          <DialogDescription>
            Register an asset for workers to test against. Kind is a free string; unknown kinds are supported.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entity-kind">Kind</Label>
              <Input
                id="entity-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                placeholder="host"
                list="entity-kind-options"
                autoComplete="off"
                required
              />
              <datalist id="entity-kind-options">
                {[
                  "host",
                  "url",
                  "ip",
                  "subdomain",
                  "endpoint",
                  "service",
                  "app",
                  "file",
                  "function",
                  "dataset",
                  "model",
                ].map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entity-key">Key</Label>
              <Input
                id="entity-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="portal.example.com"
                autoComplete="off"
                required
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-label">Label</Label>
            <Input
              id="entity-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Portal host (optional)"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Parent entity</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger aria-label="Parent entity">
                <SelectValue placeholder="No parent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No parent</SelectItem>
                {parents.map((entity) => (
                  <SelectItem key={entity.id} value={entity.id}>
                    <span className="font-mono text-[11px]">{entity.id}</span>
                    <span className="truncate">
                      {kindLabel(entity.kind)} · {entity.label || entity.key}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label htmlFor="entity-in-scope" className="flex items-center gap-2 text-xs">
            <Checkbox
              id="entity-in-scope"
              checked={inScope}
              onCheckedChange={(checked) => setInScope(checked === true)}
            />
            In scope (counts toward coverage)
          </label>
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add entity"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EntitiesTab({
  projectId,
  detail,
  loading,
  refresh,
  focusEntityId,
  onOpenGraph,
  onOpenFindings,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  loading: boolean;
  refresh: () => Promise<void>;
  focusEntityId?: string;
  onOpenGraph: (nodeId: string) => void;
  onOpenFindings: (entityId: string) => void;
}) {
  const entities = React.useMemo(() => detail?.entities ?? [], [detail]);
  const findings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const coverage = detail?.coverage ?? null;

  const [kindFilter, setKindFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [inScopeOnly, setInScopeOnly] = React.useState(false);
  const [untestedOnly, setUntestedOnly] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const handledFocus = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!focusEntityId) {
      handledFocus.current = null;
      return;
    }
    if (handledFocus.current === focusEntityId) return;
    const target = entities.find((entity) => entity.id === focusEntityId);
    if (!target) return;
    handledFocus.current = focusEntityId;
    setKindFilter("all");
    setInScopeOnly(false);
    setUntestedOnly(false);
    setQuery(target.key);
    setSelectedId(target.id);
  }, [entities, focusEntityId]);

  const kindCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [entities]);

  const matched = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...entities]
      .filter((entity) => {
        if (kindFilter !== "all" && entity.kind !== kindFilter) return false;
        if (inScopeOnly && !entity.in_scope) return false;
        if (untestedOnly && entity.tested) return false;
        if (!needle) return true;
        return (
          entity.key.toLowerCase().includes(needle) ||
          entity.label.toLowerCase().includes(needle) ||
          entity.id.toLowerCase().includes(needle) ||
          entity.kind.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  }, [entities, inScopeOnly, kindFilter, query, untestedOnly]);

  const visible = matched.slice(0, ROW_LIMIT);
  const selected = selectedId ? (entities.find((entity) => entity.id === selectedId) ?? null) : null;

  const tested = coverage?.tested ?? entities.filter((entity) => entity.tested).length;
  const denominator = coverage?.denominator ?? entities.filter((entity) => entity.in_scope).length;
  const scopeRows = coverage?.scope_rows ?? entities.filter((entity) => entity.in_scope).length;
  const filtersActive = query.trim() !== "" || kindFilter !== "all" || inScopeOnly || untestedOnly;

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <TagsIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold">Test assets</span>
            <span className="text-[11px] text-muted-foreground">
              {formatNumber(entities.length)} entities · {formatNumber(tested)}/{formatNumber(denominator)} tested ·{" "}
              {formatNumber(scopeRows)} in scope
            </span>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Add entity
          </Button>
        </div>

        {entities.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-muted-foreground">
            No entities recorded yet — agents register them through the write-back API.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2.5 border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Kinds</span>
                <button
                  type="button"
                  aria-pressed={kindFilter === "all"}
                  onClick={() => setKindFilter("all")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                    kindFilter === "all" ? "border-foreground/20 bg-muted" : "bg-card hover:bg-muted/60",
                  )}
                >
                  All
                  <span className="tabular-nums text-muted-foreground">{entities.length}</span>
                </button>
                {kindCounts.map(([kind, count]) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={kindFilter === kind}
                    onClick={() => setKindFilter(kind === kindFilter ? "all" : kind)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                      kindFilter === kind ? "bg-muted" : "bg-card hover:bg-muted/60",
                    )}
                  >
                    <KindDot kind={kind} />
                    {kindLabel(kind)}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1 sm:max-w-xs">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search key or label…"
                    className="h-8 pl-8 text-xs"
                    aria-label="Search entities"
                  />
                </div>
                <Button
                  size="sm"
                  variant={inScopeOnly ? "secondary" : "outline"}
                  className="h-8 text-xs"
                  aria-pressed={inScopeOnly}
                  onClick={() => setInScopeOnly((value) => !value)}
                >
                  In scope only
                </Button>
                <Button
                  size="sm"
                  variant={untestedOnly ? "secondary" : "outline"}
                  className="h-8 text-xs"
                  aria-pressed={untestedOnly}
                  onClick={() => setUntestedOnly((value) => !value)}
                >
                  Untested
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {formatNumber(visible.length)} of {formatNumber(matched.length)} shown
                  {matched.length > ROW_LIMIT ? ` · limit ${formatNumber(ROW_LIMIT)}` : ""}
                </span>
              </div>
            </div>

            {loading && entities.length === 0 ? (
              <div className="divide-y">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={`entity-skeleton-${index.toString()}`} className="px-4 py-3">
                    <Skeleton className="h-4 w-full max-w-xl" />
                    <Skeleton className="mt-2 h-3 w-1/3" />
                  </div>
                ))}
              </div>
            ) : visible.length === 0 ? (
              <div className="px-4 py-12 text-center text-xs text-muted-foreground">
                No entities match this search or filter.
                {filtersActive && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-1 h-auto px-1 text-xs"
                    onClick={() => {
                      setQuery("");
                      setKindFilter("all");
                      setInScopeOnly(false);
                      setUntestedOnly(false);
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-4">Label</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Tested</TableHead>
                      <TableHead>In scope</TableHead>
                      <TableHead className="hidden xl:table-cell">Source</TableHead>
                      <TableHead className="hidden text-right xl:table-cell">Facts</TableHead>
                      <TableHead className="px-4 text-right">Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((entity) => (
                      <TableRow
                        key={entity.id}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(entity.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(entity.id);
                          }
                        }}
                        aria-label={`Open ${entity.label || entity.key}`}
                      >
                        <TableCell className="max-w-56 px-4 py-2">
                          <div className="truncate font-medium">{entity.label || entity.key}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">{entity.id}</div>
                        </TableCell>
                        <TableCell className="py-2">
                          <KindBadge kind={entity.kind} />
                        </TableCell>
                        <TableCell className="max-w-64 truncate py-2 font-mono text-[11px]" title={entity.key}>
                          {entity.key}
                        </TableCell>
                        <TableCell className="py-2">{testedBadge(entity.tested)}</TableCell>
                        <TableCell className="py-2">{scopeBadge(entity.in_scope)}</TableCell>
                        <TableCell className="hidden py-2 text-muted-foreground xl:table-cell">
                          {entity.source || "—"}
                        </TableCell>
                        <TableCell className="hidden py-2 text-right font-mono tabular-nums xl:table-cell">
                          {entity.fact_count}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right text-muted-foreground" suppressHydrationWarning>
                          {formatRelative(entity.last_seen_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
              {matched.length > ROW_LIMIT
                ? `Showing the first ${formatNumber(ROW_LIMIT)} of ${formatNumber(matched.length)} matching entities — narrow the search or kind filter to inspect the rest.`
                : `${formatNumber(matched.length)} entities shown${filtersActive ? " (filtered)" : ""}.`}
            </div>
          </>
        )}
      </Card>

      <AddEntityDialog
        projectId={projectId}
        entities={entities}
        open={addOpen}
        onOpenChange={setAddOpen}
        onRefresh={refresh}
      />

      <EntityDrawer
        projectId={projectId}
        entity={selected}
        entities={entities}
        findings={findings}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onRefresh={refresh}
        onOpenGraph={onOpenGraph}
        onOpenFindings={onOpenFindings}
      />
    </div>
  );
}
