import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Provide fake email-delivery env so the delivery-config gate is satisfied
    // in tests (nodemailer is mocked, so nothing is actually sent).
    setupFiles: ["./vitest.setup.ts"],
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
