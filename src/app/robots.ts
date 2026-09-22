import type { MetadataRoute } from "next";

const BASE_URL = "https://civicfix-sbte.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/auth/",
        "/dashboard",
        "/admin",
        "/department",
        "/government",
        "/notifications",
        "/report/analysis",
        "/report/complaint",
        "/reports/",
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
