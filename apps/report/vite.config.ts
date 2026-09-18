import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Local only. There is deliberately no deploy target, no Cloudflare config and
 * no publish step in this phase — the app runs on localhost and nowhere else.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Point at the analysis core's SOURCE rather than its build output, so
      // `pnpm dev` picks up a change to a detector without a separate build.
      "@kurtosys/har-insights": fileURLToPath(
        new URL("../../packages/har-insights/src/index.ts", import.meta.url),
      ),
    },
  },
  server: { port: 5173 },
});
