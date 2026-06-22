import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("example environment security", () => {
  it("does not ship a populated SMTP relay password", () => {
    const envExample = fs.readFileSync(
      path.join(process.cwd(), ".env.example"),
      "utf8",
    );

    expect(envExample).toContain("USE_SMTP_RELAY=false");
    expect(envExample).toMatch(/^EMAIL_SERVER_PASSWORD=\s*$/m);
  });
});
