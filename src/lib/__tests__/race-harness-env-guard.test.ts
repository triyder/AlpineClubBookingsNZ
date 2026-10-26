// #4107: the race harness's environment check names what a suite left changed.
// Importing the module also registers its harness check here; this file
// changes no variable, so that check passes too.
import { describe, expect, it } from "vitest";

import { envDrift } from "@/lib/__tests__/support/race-harness-env-guard";

const RACE = "postgresql://race:race@127.0.0.1:55442/concurrency_race_1881";

describe("envDrift", () => {
  it("is empty when nothing changed", () => {
    expect(envDrift({ A: "1", B: undefined }, { A: "1" }, RACE)).toEqual([]);
  });

  it("names a variable changed, added or removed", () => {
    expect(envDrift({ A: "1", GONE: "x" }, { A: "2", APP_ENVIRONMENT_ROLE: "production" }, RACE)).toEqual([
      "A",
      "APP_ENVIRONMENT_ROLE",
      "GONE",
    ]);
  });

  it("exempts DATABASE_URL only when it points at the race database", () => {
    expect(envDrift({ DATABASE_URL: "postgresql://dummy" }, { DATABASE_URL: RACE }, RACE)).toEqual([]);
    expect(envDrift({ DATABASE_URL: "postgresql://dummy" }, { DATABASE_URL: "postgresql://elsewhere" }, RACE)).toEqual(["DATABASE_URL"]);
    expect(envDrift({ DATABASE_URL: "postgresql://dummy" }, { DATABASE_URL: "" }, "")).toEqual(["DATABASE_URL"]);
  });
});
