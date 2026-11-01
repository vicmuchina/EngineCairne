"use client";

import Link from "next/link";

import { ExternalLink, Settings2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { APP_CONFIG } from "@/config/app-config";
import { useCurrentUser } from "@/hooks/use-current-user";
import { getInitials } from "@/lib/utils";

/**
 * Topbar identity control. Replaces Artex's AccountSwitcher (which listed
 * users and called auth endpoints) with the Cairn local actor.
 */
export function ActorMenu() {
  const actor = useCurrentUser();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Local actor: ${actor.email}`}
          className="rounded-lg outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Avatar className="size-8 rounded-lg">
            <AvatarFallback>{getInitials(actor.name)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 space-y-1 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="size-9 rounded-lg">
              <AvatarFallback>{getInitials(actor.name)}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{APP_CONFIG.name}</span>
              <span className="truncate text-muted-foreground text-xs">{APP_CONFIG.actor.role}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link prefetch={false} href="/system/settings">
            <Settings2 />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="http://127.0.0.1:8000/" target="_blank" rel="noreferrer">
            <ExternalLink />
            Cairn classic UI
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
