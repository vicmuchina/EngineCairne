"use client";

import * as React from "react";

import {
  CheckCircle2Icon,
  DatabaseIcon,
  ExternalLinkIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RefreshCwIcon,
  ServerIcon,
  SunIcon,
  TimerIcon,
  UserRoundIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { APP_CONFIG } from "@/config/app-config";
import { useCairnProjects } from "@/hooks/use-cairn";
import { cairn, type CairnSettings } from "@/lib/cairn-api";
import { formatNumber } from "@/lib/cairn-format";
import type { ThemeMode, ThemePreset } from "@/lib/preferences/theme";
import { THEME_PRESET_OPTIONS } from "@/lib/preferences/theme";
import { applyThemePreset } from "@/lib/preferences/theme-utils";
import { persistPreference } from "@/lib/preferences/preferences-storage";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

function InfoRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("min-w-0 truncate text-right text-[11px]", mono && "font-mono")}>{children}</div>
    </div>
  );
}

export default function SystemSettingsPage() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const setThemePreset = usePreferencesStore((s) => s.setThemePreset);

  const [settings, setSettings] = React.useState<CairnSettings | null>(null);
  const [settingsError, setSettingsError] = React.useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = React.useState(true);

  const { projects, loading: projectsLoading, refreshing, error: projectsError, refresh } = useCairnProjects(0);

  const loadSettings = React.useCallback(async () => {
    setSettingsLoading(true);
    try {
      const next = await cairn.getSettings();
      setSettings(next);
      setSettingsError(null);
    } catch (cause) {
      setSettingsError((cause as Error).message);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const onThemeModeChange = (mode: ThemeMode | "") => {
    if (!mode) return;
    setThemeMode(mode);
    void persistPreference("theme_mode", mode);
  };

  const onThemePresetChange = (preset: ThemePreset) => {
    applyThemePreset(preset);
    setThemePreset(preset);
    void persistPreference("theme_preset", preset);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 pb-6">
      {/* ── Header ── */}
      <div>
        <h1 className="font-semibold text-lg tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Appearance and the local Cairn connection. No accounts; everything stays local.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* ── Appearance ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <PaletteIcon className="size-4 text-muted-foreground" />
              Appearance
            </CardTitle>
            <CardDescription className="text-xs">
              Dark is the default; light is one click away here or in the topbar.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label className="font-medium text-xs">Theme mode</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={themeMode}
                onValueChange={onThemeModeChange}
                className="**:data-[slot=toggle-group-item]:flex-1"
              >
                <ToggleGroupItem value="light" aria-label="Light theme">
                  <SunIcon data-icon="inline-start" />
                  Light
                </ToggleGroupItem>
                <ToggleGroupItem value="dark" aria-label="Dark theme">
                  <MoonIcon data-icon="inline-start" />
                  Dark
                </ToggleGroupItem>
                <ToggleGroupItem value="system" aria-label="System theme">
                  <MonitorIcon data-icon="inline-start" />
                  System
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1.5">
              <Label className="font-medium text-xs">Theme preset</Label>
              <Select value={themePreset} onValueChange={onThemePresetChange}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="Preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {THEME_PRESET_OPTIONS.map((preset) => (
                      <SelectItem key={preset.value} className="text-xs" value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Sidebar style, collapse mode, font, page layout and navbar behavior stay in the topbar preferences popover.
            </p>
          </CardContent>
        </Card>

        {/* ── Workspace ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ServerIcon className="size-4 text-muted-foreground" />
              Workspace
            </CardTitle>
            <CardDescription className="text-xs">Local Cairn endpoints and identity.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <InfoRow label="API proxy" mono>
              /api → 127.0.0.1:8000
            </InfoRow>
            <InfoRow label="Cairn classic UI" mono>
              <a
                className="inline-flex items-center gap-1 hover:underline"
                href="http://127.0.0.1:8000/"
                target="_blank"
                rel="noreferrer"
              >
                127.0.0.1:8000
                <ExternalLinkIcon className="size-3" />
              </a>
            </InfoRow>
            <InfoRow label="Local actor" mono>
              <span className="inline-flex items-center gap-1">
                <UserRoundIcon className="size-3 text-muted-foreground" />
                local
              </span>
            </InfoRow>
            <InfoRow label="Version" mono>
              Cairn web {APP_CONFIG.version}
            </InfoRow>
            <InfoRow label="Accounts">
              <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                local only
              </Badge>
            </InfoRow>
          </CardContent>
        </Card>

        {/* ── Dispatcher (read-only) ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <TimerIcon className="size-4 text-muted-foreground" />
              Dispatcher
            </CardTitle>
            <CardDescription className="text-xs">
              Read-only values from the running dispatcher.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {settingsLoading ? (
              <>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </>
            ) : settings ? (
              <>
                <InfoRow label="Intent timeout" mono>
                  {formatNumber(settings.intent_timeout)} s
                </InfoRow>
                <InfoRow label="Reason timeout" mono>
                  {formatNumber(settings.reason_timeout)} s
                </InfoRow>
              </>
            ) : (
              <Alert variant="destructive">
                <DatabaseIcon />
                <AlertTitle>Settings unavailable</AlertTitle>
                <AlertDescription>
                  <span className="font-mono text-[11px]">{settingsError ?? "Unknown error"}</span>
                </AlertDescription>
              </Alert>
            )}
            <Button size="sm" variant="outline" className="mt-1 w-fit" onClick={() => void loadSettings()}>
              <RefreshCwIcon data-icon="inline-start" />
              Reload
            </Button>
          </CardContent>
        </Card>

        {/* ── Connection ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2Icon className="size-4 text-muted-foreground" />
              Connection
            </CardTitle>
            <CardDescription className="text-xs">One-off check of GET /api/projects.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <InfoRow label="Status">
              <Badge
                variant="outline"
                className={cn(
                  "text-[11px]",
                  projectsError
                    ? "border-red-500/30 bg-red-500/10 text-red-400"
                    : projectsLoading
                      ? "text-muted-foreground"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                )}
              >
                {projectsError ? "Unreachable" : projectsLoading ? "Checking" : "Connected"}
              </Badge>
            </InfoRow>
            <InfoRow label="Projects" mono>
              {projectsLoading ? "…" : formatNumber(projects.length)}
            </InfoRow>
            {projectsError && (
              <p className="break-words font-mono text-[11px] text-destructive">{projectsError}</p>
            )}
            <Button size="sm" variant="outline" className="mt-1 w-fit" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCwIcon data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
              Check now
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="text-xs text-muted-foreground">
        {APP_CONFIG.meta.title} · local Cairn workspace
      </div>
    </div>
  );
}
