import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
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

export default nextConfig;
