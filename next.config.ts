import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import path from "path";

/** Baseline hardening headers for every route. No full CSP yet: Mapbox GL
 * needs blob: workers and inline styles, and a wrong CSP silently breaks the
 * map — frame-ancestors alone is safe and blocks clickjacking. Geolocation
 * and camera stay allowed for this origin (GPS location and photo capture). */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(self), microphone=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  experimental: {
    serverActions: {
      // Next's own default is 1MB — well under this app's documented 8MB
      // photo limit (src/lib/upload-limits.ts), so every report/resolution
      // photo upload above ~1MB was silently failing with a 413 before the
      // app's own size-validation error ever ran (found via the Phase 4
      // Step 10 E2E upload test). 9MB covers the 8MB image plus
      // multipart/form-data overhead and the report's other form fields.
      bodySizeLimit: "9mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        // Matches any Supabase project's Storage host so this keeps working
        // if NEXT_PUBLIC_SUPABASE_URL ever points at a different project.
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/sign/**",
      },
    ],
  },
};

/**
 * `next dev` only: also allow signed Storage URLs from the LOCAL Supabase CLI
 * stack (http://127.0.0.1:54321) — exact protocol, host, port and signed-URL
 * path, nothing broader. Next 16 blocks optimizing local-IP images by
 * default, so the dev server additionally needs dangerouslyAllowLocalIP.
 * `next build` / `next start` (production) get `nextConfig` exactly as above.
 */
export default function config(phase: string): NextConfig {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
  return {
    ...nextConfig,
    images: {
      ...nextConfig.images,
      dangerouslyAllowLocalIP: true,
      remotePatterns: [
        ...(nextConfig.images?.remotePatterns ?? []),
        { protocol: "http", hostname: "127.0.0.1", port: "54321", pathname: "/storage/v1/object/sign/**" },
      ],
    },
  };
}
