"use client";

import Link from "next/link";

import { useShallow } from "zustand/react/shallow";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { useCurrentUser } from "@/hooks/use-current-user";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";

/**
 * Cairn mark: three stacked stones with the Artex purple→blue gradient, drawn
 * inline so the fork carries no Artex logo file.
 */
function CairnMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-8! shrink-0 ${className ?? ""}`} aria-hidden="true">
      <defs>
        <linearGradient id="cairn-mark" x1="3" y1="20" x2="21" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <g fill="url(#cairn-mark)">
        <rect x="2.4" y="16.1" width="19.2" height="3.9" rx="1.7" />
        <rect x="5.6" y="11.8" width="12.8" height="3.3" rx="1.5" />
        <rect x="8.7" y="8" width="6.6" height="2.8" rx="1.3" />
      </g>
    </svg>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const currentUser = useCurrentUser();
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.sidebarVariant,
      sidebarCollapsible: s.sidebarCollapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={APP_CONFIG.name}>
              <Link prefetch={false} href="/dashboard">
                <CairnMark />
                <span className="font-semibold text-base tracking-[0.09em]">{APP_CONFIG.name}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={sidebarItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={currentUser} />
      </SidebarFooter>
    </Sidebar>
  );
}
