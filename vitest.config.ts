import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Never descend into agent git worktrees (.claude/worktrees/*): they hold
    // stale snapshots of the repo whose test files would otherwise be collected
    // and run against the main source via the "@" alias.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
