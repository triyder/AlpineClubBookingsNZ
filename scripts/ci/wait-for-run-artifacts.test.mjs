import { spawnSync } from "node:child_process";
import path from "node:path";

import { classifyArtifactWait, parseArtifactWaitArgs, waitForRunArtifacts } from "./wait-for-run-artifacts.mjs";

const wanted = ["e2e-app-image-1", "e2e-seeded-db-1"];
const upstream = ["E2E app image", "E2E seeded database"];
const job = (name, status = "in_progress", conclusion = null) => ({ name, status, conclusion });
const artifact = (name, expired = false) => ({ name, expired });

describe("waiting for this run's artifacts in a required job (#4397)", () => {
  it("parses its arguments and refuses anything else", () => {
    expect(parseArtifactWaitArgs(["--artifact", "a-1", "--upstream", "E2E app image", "--max-wait-minutes", "45"])).toEqual({ artifacts: ["a-1"], upstream: ["E2E app image"], maxWaitMs: 45 * 60_000 });
    expect(() => parseArtifactWaitArgs([])).toThrow(/At least one --artifact/);
    expect(() => parseArtifactWaitArgs(["--artifact", "a b"])).toThrow(/Invalid --artifact/);
    expect(() => parseArtifactWaitArgs(["--artifact"])).toThrow(/needs a value/);
    expect(() => parseArtifactWaitArgs(["--needs", "x"])).toThrow(/Unknown argument/);
  });

  it("is ready only when every wanted, unexpired artifact is present", () => {
    const jobs = [job(upstream[0], "completed", "success"), job(upstream[1], "completed", "success")];
    expect(classifyArtifactWait({ artifacts: wanted.map((name) => artifact(name)), jobs, wanted, upstream })).toEqual({ missing: [], upstreamDone: true });
    expect(classifyArtifactWait({ artifacts: [artifact(wanted[0])], jobs: [jobs[0], job(upstream[1])], wanted, upstream })).toEqual({ missing: [wanted[1]], upstreamDone: false });
    expect(classifyArtifactWait({ artifacts: [artifact(wanted[0]), artifact(wanted[1], true)], jobs: [jobs[0], job(upstream[1])], wanted, upstream }).missing).toEqual([wanted[1]]);
  });

  it("fails at once when an upstream job fails, is cancelled or is skipped", () => {
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      expect(() => classifyArtifactWait({ artifacts: [], jobs: [job(upstream[0], "completed", conclusion)], wanted, upstream })).toThrow(new RegExp(`completed as ${conclusion}`));
    }
  });

  it("gives up when an artifact is still missing on two polls after every upstream job succeeded, but not on one", async () => {
    const done = [job(upstream[0], "completed", "success"), job(upstream[1], "completed", "success")];
    // The artifacts listing trails the jobs listing by one poll: no failure.
    let polls = 0;
    await expect(waitForRunArtifacts({
      wanted, upstream,
      loadJobs: async () => done,
      loadArtifacts: async () => (++polls >= 2 ? wanted.map((name) => artifact(name)) : [artifact(wanted[0])]),
      sleep: async () => {}, maxWaitMs: 60_000,
    })).resolves.toBeUndefined();
    // Still missing on the second poll: it will never be uploaded.
    await expect(waitForRunArtifacts({
      wanted, upstream,
      loadJobs: async () => done,
      loadArtifacts: async () => [artifact(wanted[0])],
      sleep: async () => {}, maxWaitMs: 60_000,
    })).rejects.toThrow(/never appeared/);
  });

  it("times out rather than waiting for ever", async () => {
    let clock = 0;
    await expect(waitForRunArtifacts({
      wanted,
      upstream,
      loadArtifacts: async () => [],
      loadJobs: async () => [job(upstream[0]), job(upstream[1])],
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxWaitMs: 30_000,
      intervalMs: 15_000,
    })).rejects.toThrow(/Timed out waiting for artifacts: e2e-app-image-1, e2e-seeded-db-1/);
  });

  it("the CLI fails closed without a GitHub run identity", () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "wait-for-run-artifacts.mjs"), "--artifact", "a-1"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "", GITHUB_TOKEN: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Waiting for this run's artifacts failed");
  });
});
