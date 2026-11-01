"use client";

import * as React from "react";

import Link from "next/link";

import { ArrowUpCircleIcon } from "lucide-react";

import { api } from "@/lib/api";

/**
 * The "a new version is available" hint in the top bar: it is queried once per full page load and lights up beside the version number when there is an update,
 * going straight to the "Version and updates" card on the system configuration page when clicked.
 *
 * The backend caches its GitHub query for 30 minutes, so querying on every mount here is safe
 * -- the unauthenticated GitHub API allows only 60 requests per hour per IP, and without that cache a few open tabs
 * would burn through the quota, leaving the query broken exactly when an update is really wanted.
 *
 * A failed query is always silent: the top bar is not the place for errors, and the user sees the reason by clicking "check for updates" on the settings page.
 */
export function UpdateBadge() {
  const [latest, setLatest] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    api
      .checkUpdate()
      .then((r) => {
        // has_update already includes the "the versions are comparable" check, so a development build never lights this hint up.
        if (alive && r.has_update && r.latest) setLatest(r.latest.replace(/^v(?=\d)/, ""));
      })
      .catch(() => {
        // Silent: neither being offline nor GitHub rate limiting should pop an error in the top bar.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!latest) return null;

  return (
    <Link
      href="/system/settings"
      title={`A new version ${latest} is available; click to update`}
      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
    >
      {/* The pulsing dot: the top bar is busy and plain text is easy to miss, so the animation makes it visible at a glance. */}
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary-foreground opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
      </span>
      <ArrowUpCircleIcon className="size-3.5" />
      <span className="hidden sm:inline">New version {latest}</span>
      <span className="sm:hidden">New version</span>
    </Link>
  );
}
