import { execFileSync } from "node:child_process";

/**
 * #4411: the repository-root dotenv files Git TRACKS (`.env.example`,
 * `.env.staging.example`), never whatever sits in the working tree. A developer
 * who follows the docs (`cp .env.staging.example .env.staging`, or a local
 * `.env`) has untracked copies with real settings in them; the censuses judge
 * what the tracked files say, so those must not count.
 *
 * Root only: the `:(glob)` pathspec stops `*` matching `/`, so a tracked
 * `.env.d/…` is not read as a root dotenv file. Deduplicated, because a
 * mid-merge index lists a conflicted path once per stage. One home for
 * `email-delivery-boundary-census.test.ts` and `env-delivery-census.test.ts`.
 */
export function trackedRootDotenvFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", ":(glob).env*"], { cwd: root, encoding: "utf8" });
  return [...new Set(listed.split("\0").filter((name) => /^\.env($|\.)/.test(name) && !name.includes("/")))].sort();
}
