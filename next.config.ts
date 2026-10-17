import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {};

export default nextConfig;

// Exposes Cloudflare bindings (D1, service bindings) to `next dev` through wrangler's
// local platform proxy. It is a no-op outside the dev server.
if (process.env.NODE_ENV === "development") {
  void initOpenNextCloudflareForDev();
}
