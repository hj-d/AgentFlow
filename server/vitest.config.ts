import { defineConfig } from "vitest/config";

export default defineConfig({
  // src uses NodeNext-style ".js" extensions in relative imports; map them to the .ts source.
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
  },
});
