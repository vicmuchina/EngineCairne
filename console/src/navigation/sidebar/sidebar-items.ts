import { FolderKanban, LayoutDashboard, type LucideIcon, MessageSquare, Settings2 } from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

// Round 0 visible nav only. Pentest routes (Traffic, Assets, Workspace, System
// LLM/Agent/MCP/Skill/Tools/Notifications/Intercept/Approvals/Logs) are removed
// from the visible navigation; their source stays on disk but unreachable.
export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "Features",
    items: [
      { id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      { id: "projects", title: "Projects", url: "/projects", icon: FolderKanban },
      { id: "chat", title: "Conversations", url: "/chat", icon: MessageSquare },
    ],
  },
  {
    id: 2,
    label: "System",
    items: [{ id: "settings", title: "Settings", url: "/system/settings", icon: Settings2 }],
  },
];
