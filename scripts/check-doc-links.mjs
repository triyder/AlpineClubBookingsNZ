#!/usr/bin/env node
/**
 * Offline documentation link checker (issue #2049).
 *
 * Walks every tracked Markdown file and verifies that each RELATIVE link (and
 * relative image) resolves to a file that exists on disk. External URLs
 * (http/https/mailto/tel), in-page anchors (`#section`), and protocol-relative
 * links are intentionally NOT fetched — CI keeps external-URL checking out of
 * the blocking path to stay deterministic (see .github/workflows/docs-link-check.yml
 * and lychee.toml). This script is the fast local equivalent: run it before
 * pushing docs changes.
 *
 *   npm run docs:linkcheck            # check, exit non-zero on any broken link
 *   node scripts/check-doc-links.mjs  # same
 *
 * It parses inline Markdown links `[text](target)`, reference definitions
 * `[label]: target`, and inline images `![alt](target)`. Link fragments
 * (`file.md#anchor`) are validated against the target file's existence only;
 * anchor resolution is out of scope (lychee covers fragment checking in CI when
 * enabled).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, ".."));

// Directories we never scan: dependencies, build output, VCS, and Playwright
// artifacts. Keep this aligned with lychee.toml's exclude_path.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "playwright-report",
  "coverage",
  ".turbo",
]);

/** Recursively collect *.md files under `dir`, skipping IGNORED_DIRS. */
function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectMarkdown(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Inline links/images: ![alt](target) and [text](target). The target group
// stops at whitespace or ')', so `[x](a.md "title")` yields `a.md`.
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
// Reference definitions at line start: [label]: target
const REF_DEF = /^\s*\[[^\]]+\]:\s*(\S+)/;

function isExternalOrAnchor(target) {
  if (!target) return true;
  if (target.startsWith("#")) return true; // in-page anchor
  if (target.startsWith("//")) return true; // protocol-relative
  // Scheme like http:, https:, mailto:, tel:, data:
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  return false;
}

function normalizeTarget(raw) {
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
  // Strip any anchor/fragment and query.
  const hashIdx = t.indexOf("#");
  if (hashIdx !== -1) t = t.slice(0, hashIdx);
  // Percent-encoded path segments (e.g. %5Bdate%5D for a Next.js [date] route)
  // are valid links; decode before checking the filesystem.
  try {
    t = decodeURIComponent(t);
  } catch {
    // Leave malformed encodings as-is; they will simply fail existence.
  }
  return t;
}

function checkFile(mdPath, problems) {
  const rel = path.relative(REPO_ROOT, mdPath);
  const lines = fs.readFileSync(mdPath, "utf8").split(/\r?\n/);
  const dir = path.dirname(mdPath);

  let inFence = false;
  lines.forEach((line, i) => {
    const fenceToggle = /^\s*(```|~~~)/.test(line);
    if (fenceToggle) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Strip inline-code spans (`...`) so example link syntax shown as code — e.g.
    // `![alt](images/x.png)` in a style guide — is not treated as a real link.
    const scannable = line.replace(/`[^`]*`/g, " ");

    const targets = [];
    for (const m of scannable.matchAll(INLINE_LINK)) targets.push(m[1]);
    const refMatch = scannable.match(REF_DEF);
    if (refMatch) targets.push(refMatch[1]);

    for (const raw of targets) {
      if (isExternalOrAnchor(raw)) continue;
      const target = normalizeTarget(raw);
      if (!target) continue; // pure anchor after stripping
      const resolved = path.resolve(dir, target);
      if (!fs.existsSync(resolved)) {
        problems.push({
          file: rel,
          line: i + 1,
          target: raw,
          resolved: path.relative(REPO_ROOT, resolved),
        });
      }
    }
  });
}

function main() {
  const files = collectMarkdown(REPO_ROOT).sort();
  const problems = [];
  for (const f of files) checkFile(f, problems);

  console.log(`Checked ${files.length} Markdown files for relative-link breaks.`);
  if (problems.length === 0) {
    console.log("All relative links resolve. ✔");
    return;
  }

  console.error(`\n${problems.length} broken relative link(s):\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ->  ${p.target}  (missing: ${p.resolved})`);
  }
  process.exitCode = 1;
}

main();
