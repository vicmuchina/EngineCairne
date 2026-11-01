"use client";

import * as React from "react";

import { cairn, type ProjectDetail, type ProjectSummary } from "@/lib/cairn-api";

interface ProjectsState {
  projects: ProjectSummary[];
  /** True until the first response (success or failure) lands. */
  loading: boolean;
  /** True while any request is in flight, including background polls. */
  refreshing: boolean;
  error: string | null;
  updatedAt: Date | null;
  refresh: () => Promise<void>;
}

/**
 * Project summaries with optional polling. Stale data survives transient
 * failures; the error string reports the latest failed attempt.
 */
export function useCairnProjects(pollMs = 15000): ProjectsState {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);

  const alive = React.useRef(true);
  const inFlight = React.useRef(false);

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const items = await cairn.listProjects();
      if (!alive.current) return;
      setProjects(items);
      setError(null);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (!alive.current) return;
      setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    alive.current = true;
    void load();
    if (pollMs <= 0) {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs]);

  return { projects, loading, refreshing, error, updatedAt, refresh: load };
}

interface DetailState {
  detail: ProjectDetail | null;
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  refresh: () => Promise<void>;
}

/** Single project detail (meta + facts + intents + hints), optionally polled. */
export function useCairnProject(id: string | undefined, pollMs = 0): DetailState {
  const [detail, setDetail] = React.useState<ProjectDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const alive = React.useRef(true);
  // Tracks which project already showed the initial skeleton, so switching
  // tabs or toggling polling does not flash the loading state again.
  const loadedFor = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    if (!id) return;
    try {
      const next = await cairn.getProject(id);
      if (!alive.current) return;
      setDetail(next);
      setError(null);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (!alive.current) return;
      setError((cause as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    alive.current = true;
    if (loadedFor.current !== (id ?? null)) {
      loadedFor.current = id ?? null;
      setLoading(true);
    }
    void load();
    if (pollMs <= 0) {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs, id]);

  return { detail, loading, error, updatedAt, refresh: load };
}

/**
 * Fetch details for the most recent projects (bounded so the dashboard stays
 * cheap as the project list grows). Returns a map keyed by project id.
 */
// ── Runtime v2 activity / overview ───────────────────────────────────────────

import { deriveActivityItems } from "@/lib/cairn-activity";
import {
  CairnApiError,
  type ProjectActivityItem,
  type ProjectOverview,
} from "@/lib/cairn-api";

interface ActivityState {
  items: ProjectActivityItem[];
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
}

/**
 * Unified project feed. Uses GET /projects/{id}/activity; only a genuine 404
 * falls back to the detail-derived feed (older Runtime v1/v2 servers).
 */
export function useProjectActivity(
  id: string | undefined,
  { limit = 200, pollMs = 0 }: { limit?: number; pollMs?: number } = {},
): ActivityState {
  const [items, setItems] = React.useState<ProjectActivityItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const loadedKey = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    try {
      let all: ProjectActivityItem[] = [];
      try {
        // The API pages forward (oldest first) and stops at `limit`; page to the
        // end so "newest first" really is the newest, not the first page.
        let after: string | undefined;
        let pages = 0;
        let more = true;
        while (more && pages < 20) {
          const feed = await cairn.getProjectActivity(id, { limit, after });
          all = all.concat(feed.items);
          const next = feed.next_cursor ?? undefined;
          more = feed.has_more && Boolean(next) && next !== after;
          after = next;
          pages += 1;
          if (all.length > 10_000) break;
        }
        if (!alive.current) return;
        setItems(all);
        setHasMore(more);
      } catch (cause) {
        if (!(cause instanceof CairnApiError && cause.status === 404)) throw cause;
        const detail = await cairn.getProject(id);
        if (!alive.current) return;
        setItems(deriveActivityItems(detail));
        setHasMore(false);
      }
      if (!alive.current) return;
      setError(null);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [id, limit]);

  React.useEffect(() => {
    alive.current = true;
    const key = `${id ?? ""}:${limit}`;
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setLoading(true);
    }
    void load();
    if (pollMs <= 0) {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs, id, limit]);

  return { items, loading, error, updatedAt, hasMore, refresh: load };
}

/**
 * Merge the newest few events of several projects for the dashboard strip.
 * Only project ids are needed; titles are supplied by the caller.
 */
export function useRecentProjectActivity(
  projectIds: readonly string[],
  { pollMs = 15000 }: { pollMs?: number } = {},
): {
  items: ProjectActivityItem[];
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  refresh: () => Promise<void>;
} {
  const idsKey = React.useMemo(() => projectIds.slice(0, 12).join(","), [projectIds]);
  const [items, setItems] = React.useState<ProjectActivityItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const loadedKey = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    if (!idsKey || inFlight.current) return;
    inFlight.current = true;
    try {
      const ids = idsKey.split(",").filter(Boolean);
      const results = await Promise.allSettled(
        ids.map(async (projectId) => {
          try {
            let all: ProjectActivityItem[] = [];
            let after: string | undefined;
            let pages = 0;
            let more = true;
            // Up to three 500-row pages per project keeps the dashboard bounded
            // while still covering normal projects in one request.
            while (more && pages < 3) {
              const feed = await cairn.getProjectActivity(projectId, { limit: 500, after });
              all = all.concat(feed.items);
              const next = feed.next_cursor ?? undefined;
              more = feed.has_more && Boolean(next) && next !== after;
              after = next;
              pages += 1;
            }
            return all;
          } catch (cause) {
            if (!(cause instanceof CairnApiError && cause.status === 404)) throw cause;
            const detail = await cairn.getProject(projectId);
            return deriveActivityItems(detail);
          }
        }),
      );
      if (!alive.current) return;
      const merged = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      merged.sort((a, b) => {
        const at = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
        const bt = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
        return bt - at;
      });
      setItems(merged);
      const failures = results.filter((result) => result.status === "rejected");
      setError(failures.length === results.length && results.length > 0 ? "Could not load project activity." : null);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [idsKey]);

  React.useEffect(() => {
    alive.current = true;
    if (loadedKey.current !== idsKey) {
      loadedKey.current = idsKey;
      setLoading(true);
    }
    void load();
    if (pollMs <= 0) {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs, idsKey]);

  return { items, loading, error, updatedAt, refresh: load };
}

interface OverviewState {
  overview: ProjectOverview | null;
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  refresh: () => Promise<void>;
}

/** GET /projects/{id}/overview — real counts, workers and recent activity. */
export function useProjectOverview(id: string | undefined, pollMs = 15000): OverviewState {
  const [overview, setOverview] = React.useState<ProjectOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const loadedFor = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await cairn.getProjectOverview(id);
      if (!alive.current) return;
      setOverview(next);
      setError(null);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    alive.current = true;
    if (loadedFor.current !== (id ?? null)) {
      loadedFor.current = id ?? null;
      setLoading(true);
    }
    void load();
    if (pollMs <= 0) {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs, id]);

  return { overview, loading, error, updatedAt, refresh: load };
}
