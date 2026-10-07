import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// KV keeps the Next data cache (fetch revalidate) and ISR output across requests.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
});
