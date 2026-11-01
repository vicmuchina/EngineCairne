import { fileURLToPath } from "node:url";

// Static export: `NEXT_EXPORT=1 next build` produces a pure static directory (no /api proxy or redirects).
const isExport = process.env.NEXT_EXPORT === "1";

// The Cairn backend. Every same-origin /api/* request is proxied here with the
// /api prefix stripped (Cairn serves /projects, /chat/... at the root).
const CAIRN_API = process.env.CAIRN_API ?? "http://127.0.0.1:8000";

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Stops a lockfile in a parent directory from affecting root inference and asset path generation.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  reactCompiler: true,
  // Allow dev assets (HMR) to be served to LAN IPs.
  allowedDevOrigins: ["*.*.*.*"],
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  ...(isExport
    ? {
        output: "export",
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${CAIRN_API}/:path*` }];
        },
        // Round 0: the fork has no auth pages and no pentest routes. Anything
        // still pointing at them lands on the Cairn dashboard instead of a
        // half-wired Artex screen calling a backend that is not there.
        async redirects() {
          return [
            { source: "/login", destination: "/dashboard", permanent: false },
            { source: "/setup", destination: "/dashboard", permanent: false },
            { source: "/function/:path*", destination: "/dashboard", permanent: false },
            { source: "/system/llm", destination: "/system/settings", permanent: false },
            { source: "/system/agents/:path*", destination: "/system/settings", permanent: false },
            { source: "/system/agents", destination: "/system/settings", permanent: false },
            { source: "/system/mcp", destination: "/system/settings", permanent: false },
            { source: "/system/skills", destination: "/system/settings", permanent: false },
            { source: "/system/tools", destination: "/system/settings", permanent: false },
            { source: "/system/notify", destination: "/system/settings", permanent: false },
            { source: "/system/intercept/:path*", destination: "/system/settings", permanent: false },
            { source: "/system/logs", destination: "/system/settings", permanent: false },
          ];
        },
      }),
};

export default nextConfig;
