import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./workers/engine/src/db/schema.ts",
  out: "./migrations",
});
