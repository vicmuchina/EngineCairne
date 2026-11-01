"use client";

import { APP_CONFIG } from "@/config/app-config";

/**
 * Cairn has no login. The shell always shows the local actor, and this hook
 * never reads a token or calls an auth endpoint.
 */
export interface CurrentUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatar: string;
  role: string;
}

const LOCAL_ACTOR: CurrentUser = {
  id: "local",
  name: APP_CONFIG.actor.name,
  username: "local",
  email: APP_CONFIG.actor.role,
  avatar: "",
  role: "local",
};

export function useCurrentUser(): CurrentUser {
  return LOCAL_ACTOR;
}
