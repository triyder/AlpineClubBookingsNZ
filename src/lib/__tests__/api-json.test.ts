import { describe, expect, it } from "vitest";
import { parseJsonRequestBody } from "@/lib/api-json";

describe("API JSON parsing", () => {
  it("returns a controlled 400 response for malformed JSON", async () => {
    const result = await parseJsonRequestBody(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: "{not json",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      });
    }
  });
});
