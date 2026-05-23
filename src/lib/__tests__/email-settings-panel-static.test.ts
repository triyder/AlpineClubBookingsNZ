import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("EmailMessageSettingsPanel static safeguards", () => {
  it("renders preview HTML in a restrictive sandboxed iframe", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/admin/email-settings/email-message-settings-panel.tsx",
      ),
      "utf8",
    );

    expect(source).toMatch(/<iframe[\s\S]*sandbox=""/);
    expect(source).not.toMatch(/allow-scripts|allow-forms|allow-popups/);
  });
});
