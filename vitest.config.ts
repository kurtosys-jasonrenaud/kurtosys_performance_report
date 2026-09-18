import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live beside the code they cover, under each package's test/ dir.
    include: ["packages/*/test/**/*.test.ts"],
    // test/fixtures/ is gitignored and holds real captures handed over for
    // local validation. Nothing in there is a test file.
    exclude: ["**/node_modules/**", "**/fixtures/**"],
  },
});
