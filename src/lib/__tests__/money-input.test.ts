import { describe, expect, it } from "vitest";
import { parseDecimalDollarsToCents } from "@/lib/money-input";

describe("parseDecimalDollarsToCents", () => {
  it.each([
    ["0", 0], ["1", 100], ["1.2", 120], ["1.23", 123],
    [" 150.05 ", 15005], ["21474836.47", 2_147_483_647],
  ])("parses %s exactly", (input, expected) => {
    expect(parseDecimalDollarsToCents(input)).toBe(expected);
  });

  it.each(["", "-1", ".5", "01", "1.234", "1e2", "1,000", "21474836.48"])(
    "rejects %s",
    (input) => expect(parseDecimalDollarsToCents(input)).toBeNull(),
  );
});
