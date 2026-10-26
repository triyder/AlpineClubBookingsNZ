/**
 * #4053: the PR description reaches the PR-body gates as a FILE, never as an
 * environment variable.
 *
 * Linux caps one environment string at 128 KiB (`MAX_ARG_STRLEN`). PR #3924's
 * description reached 173 KB, so the runner could not start the step's shell
 * ("Argument list too long") and `verify` went red with no finding. These tests
 * prove (1) the gate reads a body well past that cap from `PR_BODY_FILE`, and
 * that a child process given the same body as an env var cannot even start;
 * (2) the workflow's own `jq` step round-trips such a body byte for byte; (3) no
 * workflow puts `pull_request.body` back into an `env:` or `run:`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEventPrBody, selectPrBody } from "./pr-body.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");
const changelogGate = join(
  repoRoot,
  "scripts",
  "ci",
  "check-pr-changelog-fragment.mjs",
);

/** Past Linux's 128 KiB per-string cap (131072), with room to spare. */
const BIG_BODY = `## Summary\n\n${"review round history line\n".repeat(8000)}\nchangelog: none\n`;

describe("PR body file (#4053)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-body-file-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a body that exceeds the per-string environment limit", () => {
    expect(Buffer.byteLength(BIG_BODY)).toBeGreaterThan(131072);
  });

  it("readEventPrBody reads PR_BODY_FILE in preference to PR_BODY", () => {
    const file = join(dir, "pr-body.md");
    writeFileSync(file, BIG_BODY);
    expect(readEventPrBody({ PR_BODY_FILE: file, PR_BODY: "stale" })).toBe(
      BIG_BODY,
    );
  });

  it("readEventPrBody falls back to PR_BODY when no file is named", () => {
    expect(readEventPrBody({ PR_BODY: "small body" })).toBe("small body");
    expect(
      selectPrBody({ fetchedBody: null, eventBody: readEventPrBody({}) }),
    ).toBe("");
  });

  it("readEventPrBody names the file when it cannot be read", () => {
    expect(() =>
      readEventPrBody({ PR_BODY_FILE: join(dir, "missing.md") }),
    ).toThrow(/PR_BODY_FILE .*missing\.md could not be read/);
  });

  it("the real gate entrypoint reads a >128 KB body from the file", () => {
    // A throwaway repo whose diff adds application source: code-bearing, so the
    // changelog gate passes only if it SEES the `changelog: none` marker. The
    // marker sits at the very END of the body, past the 128 KiB mark, so a read
    // that truncated or dropped the file would fail the gate.
    const repo = join(dir, "repo");
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    mkdirSync(join(repo, "src"), { recursive: true });
    git("init", "--quiet");
    git("config", "user.email", "gate-test@example.invalid");
    git("config", "user.name", "Gate Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "src", "x.ts"), "export const value = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "add source");
    const head = git("rev-parse", "HEAD").trim();

    const run = (bodyFile) =>
      spawnSync(process.execPath, [changelogGate], {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          PR_BODY_FILE: bodyFile,
          PR_BASE_SHA: base,
          PR_HEAD_SHA: head,
          PR_NUMBER: "",
          GITHUB_TOKEN: "",
          GH_TOKEN: "",
          GITHUB_REPOSITORY: "",
        },
      });
    const out = (r) => `${r.stdout}${r.stderr}`;

    const bigWithMarker = join(dir, "big-with-marker.md");
    writeFileSync(
      bigWithMarker,
      `## Summary\n\n${"history line\n".repeat(12000)}\nchangelog: none\n`,
    );
    expect(statSync(bigWithMarker).size).toBeGreaterThan(131072);
    const passed = run(bigWithMarker);
    expect(passed.error).toBeUndefined();
    expect(out(passed)).toMatch(/Changelog entry check passed/);

    // Same size, no marker: the gate must reach its real verdict, not skip.
    const bigWithout = join(dir, "big-without-marker.md");
    writeFileSync(
      bigWithout,
      `## Summary\n\n${"history line\n".repeat(12000)}`,
    );
    const failed = run(bigWithout);
    expect(failed.status).toBe(1);
    expect(out(failed)).toMatch(/changelog/i);

    // A named file that is missing fails the gate loudly.
    const missing = run(join(dir, "missing.md"));
    expect(missing.status).toBe(1);
    expect(out(missing)).toMatch(/PR_BODY_FILE .* could not be read/);
  });

  it("an environment variable over the cap cannot even start a child process", () => {
    // The failure #4053 reports, reproduced: this is why the body is a file.
    // E2BIG surfaces as a spawn error on Linux; the assertion is skipped where
    // the platform has no such cap.
    if (process.platform !== "linux") return;
    const result = spawnSync(process.execPath, ["-e", "0"], {
      env: { PATH: process.env.PATH, PR_BODY: BIG_BODY },
    });
    expect(result.error?.code).toBe("E2BIG");
  });

  it("the workflow's jq step writes a >128 KB body byte for byte", () => {
    const ci = readFileSync(join(workflowsDir, "ci.yml"), "utf8");
    const match = ci.match(
      /- name: Write the PR description to a file\n(?:.*\n)*?\s+run: (jq .*)\n/,
    );
    expect(
      match,
      "ci.yml must keep its 'Write the PR description to a file' step",
    ).not.toBeNull();
    const eventPath = join(dir, "event.json");
    const out = join(dir, "pr-body.md");
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { body: BIG_BODY } }),
    );
    const result = spawnSync("bash", ["-c", match[1]], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_PATH: eventPath,
        RUNNER_TEMP: dir,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(BIG_BODY);

    // A null body (GitHub sends null for an empty description) is an empty file.
    writeFileSync(eventPath, JSON.stringify({ pull_request: { body: null } }));
    const empty = spawnSync("bash", ["-c", match[1]], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_PATH: eventPath,
        RUNNER_TEMP: dir,
      },
    });
    expect(empty.status, empty.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("no workflow or action references the PR description in an expression", () => {
    const offenders = [];
    const actionsDir = join(workflowsDir, "..", "actions");
    const yamlFiles = (dir) =>
      existsSync(dir)
        ? readdirSync(dir, { recursive: true })
            .map(String)
            .filter((f) => /\.ya?ml$/.test(f))
            .map((f) => join(dir, f))
        : [];
    // Best-effort guard: the literal, the bracket form, and a whole-event or
    // whole-pull_request toJSON that would carry the body with it.
    const bodyExpression =
      /github\.event\.pull_request(\.body|\[['"]body['"]\])|toJSON\(\s*github\.event(\.pull_request)?\s*\)/;
    for (const name of [...yamlFiles(workflowsDir), ...yamlFiles(actionsDir)]) {
      readFileSync(name, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          if (bodyExpression.test(line)) {
            offenders.push(`${name}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      "#4053: a PR description over 128 KiB cannot be an environment string; read it from $GITHUB_EVENT_PATH into a file.",
    ).toEqual([]);
  });
});
