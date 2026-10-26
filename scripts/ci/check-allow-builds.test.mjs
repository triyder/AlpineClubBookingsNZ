import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allowBuildsProblems,
  checkWorkingTree,
  dependabotGroupProblems,
  lockfileVersions,
  readAllowBuilds,
  REAPPROVAL_GUIDE,
} from "./check-allow-builds.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CHECKER = path.join(REPO_ROOT, "scripts", "ci", "check-allow-builds.mjs");

const WORKSPACE = `nodeLinker: isolated

allowBuilds:
  "@prisma/engines@7.10.0": true
  core-js: false
  esbuild@0.28.1 || 0.27.0: true
  prisma@7.10.0: true

verifyDepsBeforeRun: error
`;

const LOCK = `lockfileVersion: '9.0'

packages:

  '@prisma/engines@7.10.0':
    resolution: {integrity: sha512-a}

  core-js@3.49.0:
    resolution: {integrity: sha512-b}

  esbuild@0.27.0:
    resolution: {integrity: sha512-c}

  esbuild@0.28.1:
    resolution: {integrity: sha512-d}

  prisma@7.10.0:
    resolution: {integrity: sha512-e}

snapshots:

  prisma@7.10.0(typescript@6.0.3):
    dependencies: {}
`;

const DEPENDABOT = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    groups:
      install-scripts:
        update-types:
          - minor
          - patch
        patterns:
          - "prisma"
          - "@prisma/*"
          - "esbuild"
      npm-minor-and-patch:
        update-types:
          - minor
          - patch
        exclude-patterns:
          - "prisma"
          - "@prisma/*"
          - "esbuild"
  - package-ecosystem: github-actions
    directory: /
`;

describe("readAllowBuilds", () => {
  it("splits scoped names, exact versions and unions, and keeps denials", () => {
    expect(readAllowBuilds(WORKSPACE)).toEqual([
      { name: "@prisma/engines", versions: ["7.10.0"], allowed: true },
      { name: "core-js", versions: [], allowed: false },
      { name: "esbuild", versions: ["0.28.1", "0.27.0"], allowed: true },
      { name: "prisma", versions: ["7.10.0"], allowed: true },
    ]);
  });

  it("refuses an answer that is neither true nor false", () => {
    expect(() => readAllowBuilds("allowBuilds:\n  prisma@7.10.0: yes\n")).toThrow(
      /unreadable allowBuilds entry `prisma@7.10.0: yes`/,
    );
  });
});

describe("lockfileVersions", () => {
  it("reads every resolved version from the packages keys, not the snapshots", () => {
    const versions = lockfileVersions(LOCK);
    expect([...versions.get("esbuild")].sort()).toEqual(["0.27.0", "0.28.1"]);
    expect([...versions.get("@prisma/engines")]).toEqual(["7.10.0"]);
    expect([...versions.get("prisma")]).toEqual(["7.10.0"]);
  });
});

describe("lockfileVersions with peer suffixes", () => {
  it("cuts a peer suffix before splitting the name, so its `@` is not the package's", () => {
    const lockText = LOCK.replace("  esbuild@0.28.1:\n", "  esbuild@0.28.1(react@19.0.0):\n");
    const versions = lockfileVersions(lockText);
    expect([...versions.get("esbuild")].sort()).toEqual(["0.27.0", "0.28.1"]);
    expect([...versions.keys()].filter((name) => name.includes("("))).toEqual([]);
    expect(allowBuildsProblems({ workspaceText: WORKSPACE, lockText })).toEqual([]);
  });
});

describe("allowBuildsProblems", () => {
  it("passes when every approval matches the lockfile", () => {
    expect(allowBuildsProblems({ workspaceText: WORKSPACE, lockText: LOCK })).toEqual([]);
  });

  it("names the package and both versions when a bump outruns its approval", () => {
    const lockText = LOCK.replaceAll("prisma@7.10.0", "prisma@7.10.1");
    expect(allowBuildsProblems({ workspaceText: WORKSPACE, lockText })).toEqual([
      "prisma: allowBuilds approves 7.10.0, but pnpm-lock.yaml resolves 7.10.1.",
    ]);
  });

  it("flags an approved union member the lockfile no longer resolves", () => {
    const lockText = LOCK.replace("  esbuild@0.27.0:\n    resolution: {integrity: sha512-c}\n\n", "");
    expect(allowBuildsProblems({ workspaceText: WORKSPACE, lockText })).toEqual([
      "esbuild: allowBuilds approves 0.28.1 || 0.27.0, but pnpm-lock.yaml resolves 0.28.1.",
    ]);
  });

  it("flags an approval for a package the lockfile no longer installs", () => {
    const workspaceText = WORKSPACE.replace("prisma@7.10.0: true", "prisma@7.10.0: true\n  sharp@0.35.5: true");
    expect(allowBuildsProblems({ workspaceText, lockText: LOCK })).toEqual([
      "sharp: allowBuilds approves 0.35.5, but pnpm-lock.yaml no longer installs sharp. Remove the entry.",
    ]);
  });

  it("flags an approval with no version", () => {
    const workspaceText = WORKSPACE.replace("prisma@7.10.0: true", "prisma: true");
    expect(allowBuildsProblems({ workspaceText, lockText: LOCK })).toEqual([
      "prisma: allowBuilds approves every version of it. Pin the exact version that was reviewed.",
    ]);
  });
});

describe("dependabotGroupProblems", () => {
  it("passes when every other group excludes every install-scripts pattern", () => {
    expect(dependabotGroupProblems({ dependabotText: DEPENDABOT, workspaceText: WORKSPACE })).toEqual([]);
  });

  it("fails the #4364 shape: a catch-all group that relies on group order", () => {
    const dependabotText = DEPENDABOT.replace(
      /        exclude-patterns:\n(?:          - .*\n)+/,
      "",
    );
    const problems = dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('group `npm-minor-and-patch` does not exclude "prisma", "@prisma/*", "esbuild"');
  });

  it("fails one missing exclusion by name", () => {
    // The second listing of the pattern is the one under `exclude-patterns`.
    const line = '          - "@prisma/' + '*"\n';
    const at = DEPENDABOT.lastIndexOf(line);
    expect(at).toBeGreaterThan(DEPENDABOT.indexOf("exclude-patterns:"));
    const dependabotText = DEPENDABOT.slice(0, at) + DEPENDABOT.slice(at + line.length);
    expect(dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toEqual([
      expect.stringContaining('group `npm-minor-and-patch` does not exclude "@prisma/*"'),
    ]);
  });

  it("fails when an approved package matches no install-scripts pattern", () => {
    const workspaceText = WORKSPACE.replace("prisma@7.10.0: true", "prisma@7.10.0: true\n  unrs-resolver@1.12.2: true");
    expect(dependabotGroupProblems({ dependabotText: DEPENDABOT, workspaceText })).toEqual([
      expect.stringContaining("unrs-resolver runs an approved install script, but no `install-scripts` pattern in the npm entry for `/` matches it"),
    ]);
  });
});

describe("dependabotGroupProblems across npm entries", () => {
  const second = (groups) =>
    DEPENDABOT.replace(
      "  - package-ecosystem: github-actions\n",
      `  - package-ecosystem: npm\n    directory: /tools\n    groups:\n${groups}  - package-ecosystem: github-actions\n`,
    );

  it("checks a second npm entry, not only the first", () => {
    const dependabotText = second(
      '      install-scripts:\n        patterns:\n          - "prisma"\n          - "@prisma/' +
        '*"\n          - "esbuild"\n      everything:\n        update-types:\n          - minor\n',
    );
    expect(dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toEqual([
      expect.stringContaining("the npm entry for `/tools` group `everything` does not exclude"),
    ]);
  });

  it("fails an npm entry that has groups but no install-scripts group", () => {
    const dependabotText = second("      everything:\n        update-types:\n          - minor\n");
    expect(dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toEqual([
      expect.stringContaining("the npm entry for `/tools` has `groups` but no `install-scripts` group"),
    ]);
  });

  it("leaves an npm entry with no groups alone", () => {
    const dependabotText = DEPENDABOT.replace(
      "  - package-ecosystem: github-actions\n",
      "  - package-ecosystem: npm\n    directory: /tools\n  - package-ecosystem: github-actions\n",
    );
    expect(dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toEqual([]);
  });
});

describe("dependabotGroupProblems is two-way", () => {
  it("fails a catch-all that excludes a pattern the install-scripts group does not list", () => {
    const dependabotText = DEPENDABOT.replace(
      '          - "esbuild"\n  - package-ecosystem: github-actions',
      '          - "esbuild"\n          - "lodash"\n  - package-ecosystem: github-actions',
    );
    expect(dependabotText).not.toBe(DEPENDABOT);
    expect(dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toEqual([
      expect.stringContaining('group `npm-minor-and-patch` excludes "lodash", which is not an `install-scripts` pattern'),
    ]);
  });
});

describe("dependabotGroupProblems refuses flow-style lists", () => {
  it("throws on flow-style install-scripts patterns instead of reading them as empty", () => {
    const at = DEPENDABOT.indexOf("        patterns:\n");
    const end = DEPENDABOT.indexOf("      npm-minor-and-patch:");
    const dependabotText =
      DEPENDABOT.slice(0, at) + '        patterns: ["prisma", "esbuild"]\n' + DEPENDABOT.slice(end);
    expect(() => dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toThrow(
      /group `install-scripts` `patterns` is written as a flow-style list.*Use a block sequence/,
    );
  });

  it("throws on flow-style exclude-patterns instead of reading them as empty", () => {
    const at = DEPENDABOT.indexOf("        exclude-patterns:\n");
    const end = DEPENDABOT.indexOf("  - package-ecosystem: github-actions");
    const dependabotText =
      DEPENDABOT.slice(0, at) + '        exclude-patterns: ["prisma", "esbuild"]\n' + DEPENDABOT.slice(end);
    expect(() => dependabotGroupProblems({ dependabotText, workspaceText: WORKSPACE })).toThrow(
      /group `npm-minor-and-patch` `exclude-patterns` is written as a flow-style list.*Use a block sequence/,
    );
  });
});

describe("CONTRIBUTING.md", () => {
  it("tells whoever adds an allowBuilds package to add its pattern to both Dependabot groups", () => {
    const text = readFileSync(path.join(REPO_ROOT, "CONTRIBUTING.md"), "utf8").replace(/\s+/g, " ");
    expect(text).toContain(
      "Adding a package to `allowBuilds` therefore also means adding a pattern that matches it to both " +
        "groups in `.github/dependabot.yml`",
    );
  });
});

describe("the repository's own files", () => {
  it("pass both checks", () => {
    const { allowBuilds, dependabot, approvals } = checkWorkingTree(REPO_ROOT);
    expect(allowBuilds).toEqual([]);
    expect(dependabot).toEqual([]);
    expect(approvals).toBeGreaterThan(0);
  });
});

describe("the command line", () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function treeWith({ workspace = WORKSPACE, lock = LOCK, dependabot = DEPENDABOT } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "allow-builds-"));
    made.push(dir);
    mkdirSync(path.join(dir, ".github"));
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), workspace);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), lock);
    writeFileSync(path.join(dir, ".github", "dependabot.yml"), dependabot);
    return dir;
  }

  const run = (cwd) => spawnSync(process.execPath, [CHECKER], { cwd, encoding: "utf8" });

  it("exits 0 and says what it checked on a matching tree", () => {
    const result = run(treeWith());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allowBuilds check passed: 3 approval(s) match pnpm-lock.yaml");
  });

  it("exits 1 naming the package, both versions and the review procedure", () => {
    const result = run(treeWith({ lock: LOCK.replaceAll("prisma@7.10.0", "prisma@7.10.1") }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prisma: allowBuilds approves 7.10.0, but pnpm-lock.yaml resolves 7.10.1.");
    expect(result.stderr).toContain("ERR_PNPM_IGNORED_BUILDS");
    expect(result.stderr).toContain(REAPPROVAL_GUIDE);
  });

  it("is the step verify runs before the install", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const verify = workflow.slice(workflow.indexOf("  verify:"));
    const step = verify.indexOf("run: node scripts/ci/check-allow-builds.mjs");
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(verify.indexOf("- name: Install dependencies"));
  });
});
