"use client";

import type { ReactNode } from "react";
import * as React from "react";

import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getClientCookie } from "@/lib/cookie.client";
import {
  SIDEBAR_COLLAPSIBLE_VALUES,
  SIDEBAR_VARIANT_VALUES,
  type SidebarCollapsible,
  type SidebarVariant,
} from "@/lib/preferences/layout";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { cn } from "@/lib/utils";

import { MainContent } from "./_components/main-content";

// Reads a layout-critical preference from the browser cookie. Only called after
// mount: the SSR pass and the first client render must agree, otherwise the
// sidebar data-state hydrates differently and React logs a mismatch.
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = getClientCookie(key);
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  // Cairn has no accounts: the shell opens directly, no auth gate.
  const [open, setOpen] = React.useState(true);
  const [variant, setVariant] = React.useState<SidebarVariant>(PREFERENCE_DEFAULTS.sidebar_variant);
  const [collapsible, setCollapsible] = React.useState<SidebarCollapsible>(PREFERENCE_DEFAULTS.sidebar_collapsible);

  React.useEffect(() => {
    setOpen(getClientCookie("sidebar_state") !== "false");
    setVariant(readPref<SidebarVariant>("sidebar_variant", SIDEBAR_VARIANT_VALUES, PREFERENCE_DEFAULTS.sidebar_variant));
    setCollapsible(
      readPref<SidebarCollapsible>(
        "sidebar_collapsible",
        SIDEBAR_COLLAPSIBLE_VALUES,
        PREFERENCE_DEFAULTS.sidebar_collapsible,
      ),
    );
  }, []);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant={variant} collapsible={collapsible} />
      <SidebarInset
        className={cn(
          "[html[data-content-layout=centered]_&>*]:mx-auto",
          "[html[data-content-layout=centered]_&>*]:w-full",
          "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
          "peer-data-[variant=inset]:border",
          "[--dashboard-header-height:--spacing(12)]",
          "min-w-0 overflow-x-hidden",
        )}
      >
        <MainContent>{children}</MainContent>
      </SidebarInset>
    </SidebarProvider>
  );
}
