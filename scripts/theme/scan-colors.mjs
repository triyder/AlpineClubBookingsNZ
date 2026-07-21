#!/usr/bin/env node
// scan-colors.mjs — Phase 0 raw-colour-class inventory scanner (issue #2181).
//
// PROVENANCE (R5, issue #2187): this scanner originated as the Phase-0 inventory
// script for epic #2181 and was committed verbatim (bar this header and the
// determinism fix below) to `scripts/theme/scan-colors.mjs`. It produced
// `docs/theme/phase0/data/counts.json`; running it on a fixed commit reproduces
// that file BYTE-FOR-BYTE. Every pinned-scan command in P2/P3/P4/epic points at
// this committed path.
//
// DETERMINISM: the JSON output carries no wall-clock timestamp and no absolute
// path — `meta.root` is a fixed literal and every list is sorted — so a fresh
// run on the same tree is byte-identical to the committed artifact.
//
// Counts Tailwind colour-family utility OCCURRENCES over the .ts/.tsx source
// tree, broken down by tree, family, and unique class string. It reuses the
// brand-color-source-contract gate's file-selection approach (recursively walk
// src, TS/TSX only, skip __tests__), but where the gate only asks "does this
// FILE contain a match?" over three prefixes (bg/text/border), this scanner
// TOKENISES each colour utility and COUNTS every occurrence across the full
// Tailwind colour-utility prefix set.
//
// A single occurrence = one colour-utility token (variant prefixes such as
// `dark:` / `hover:` are stripped; an optional `/opacity` suffix is captured
// but not counted as a distinct base string). Tokens are matched with a
// Tailwind-shaped grammar (PREFIX-FAMILY-SHADE), not free text, so prose words
// like "to" or "green" never register.
//
// Usage:
//   node scan-colors.mjs --root <repoRoot> [--json <outPath>]
// Deterministic: every list is sorted before printing/writing.

import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const ROOT = argVal("--root", process.cwd());
const JSON_OUT = argVal("--json", null);

// ---- grammar --------------------------------------------------------------
// The Tailwind colour-utility prefixes we count (task-specified set + a few
// one-off colour prefixes that appear in this codebase). `ring-offset` MUST
// precede `ring` in the alternation so it wins the longer match.
const PREFIXES = [
  "bg", "text", "border", "ring-offset", "ring", "divide", "outline",
  "fill", "stroke", "shadow", "from", "via", "to", "accent", "caret",
  "decoration", "placeholder",
];
const PREFIX = `(?:${PREFIXES.join("|")})`;

const COLOR_FAMILIES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose",
];
const NEUTRAL_FAMILIES = ["slate", "gray", "zinc", "neutral", "stone"];
const SHADE = "(?:50|100|200|300|400|500|600|700|800|900|950)";

// A leading (?<![\w-]) lets a `:` (variant separator), quote, brace, backtick,
// whitespace or string-start precede the token, but rejects mid-identifier
// hits. Trailing (?![\w-]) after the optional /opacity keeps us at a token
// boundary.
const coloredRe = new RegExp(
  `(?<![\\w-])${PREFIX}-(${COLOR_FAMILIES.join("|")})-(${SHADE})(/\\d{1,3})?(?![\\w-])`,
  "g",
);
const neutralShadeRe = new RegExp(
  `(?<![\\w-])${PREFIX}-(${NEUTRAL_FAMILIES.join("|")})-(${SHADE})(/\\d{1,3})?(?![\\w-])`,
  "g",
);
// The task-scoped white/black neutrals: bg-white / bg-black / text-white /
// text-black (opacity suffix allowed).
const neutralBWRe = new RegExp(
  `(?<![\\w-])(bg|text)-(white|black)(/\\d{1,3})?(?![\\w-])`,
  "g",
);

// ---- file walk (mirrors the gate's listSourceFiles) -----------------------
function listSourceFiles(absDir) {
  let out = [];
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out = out.concat(listSourceFiles(abs));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

// ---- tree classification (mutually exclusive, first match wins) -----------
// Returns a stable tree key for a repo-relative (posix) path.
function classify(rel) {
  const p = rel;
  if (p.startsWith("src/app/(admin)/")) return "app-admin";
  if (p.startsWith("src/app/(authenticated)/")) return "app-authenticated";
  if (p.startsWith("src/app/(public)/")) return "app-public";
  if (p.startsWith("src/app/(website)/")) return "app-website";
  if (p.startsWith("src/app/(finance)/")) return "app-finance";
  if (p.startsWith("src/app/(lodge)/lodge/kiosk/")) return "kiosk-lodge-kiosk";
  if (p.startsWith("src/app/(lodge)/")) return "app-lodge";
  if (p.startsWith("src/app/display/")) return "kiosk-display-route";
  if (p.startsWith("src/app/api/")) return "app-api";
  if (p.startsWith("src/app/")) return "app-root";
  if (p.startsWith("src/components/admin/")) return "components-admin";
  if (p.startsWith("src/components/finance/")) return "components-finance";
  if (p.startsWith("src/components/lodge-display/")) return "kiosk-lodge-display-components";
  if (p.startsWith("src/components/")) return "components-other";
  if (p.startsWith("src/lib/lodge-display/")) return "kiosk-lodge-display-lib";
  if (p.startsWith("src/lib/")) return "lib";
  return "other";
}

// ---- scan -----------------------------------------------------------------
const files = listSourceFiles(join(ROOT, "src")).sort();

const colored = {
  total: 0,
  byTree: {},
  byFamily: {},
  uniqueBase: {}, // baseToken -> { family, count, anchors: [file:line] }
};
const neutral = {
  total: 0,
  byTree: {},
  byFamily: {}, // includes white/black as families
};

function bump(obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n;
}

for (const abs of files) {
  const rel = relative(ROOT, abs).replaceAll("\\", "/");
  const tree = classify(rel);
  const text = readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineno = i + 1;

    for (const m of line.matchAll(coloredRe)) {
      const family = m[1];
      const full = m[0]; // e.g. bg-red-500 or border-primary... no; incl opacity
      const base = m[3] ? full.slice(0, full.length - m[3].length) : full;
      colored.total++;
      bump(colored.byTree, tree);
      bump(colored.byFamily, family);
      const u = (colored.uniqueBase[base] ||= { family, count: 0, anchors: [] });
      u.count++;
      if (u.anchors.length < 3) u.anchors.push(`${rel}:${lineno}`);
    }

    for (const m of line.matchAll(neutralShadeRe)) {
      const family = m[1];
      neutral.total++;
      bump(neutral.byTree, tree);
      bump(neutral.byFamily, family);
    }
    for (const m of line.matchAll(neutralBWRe)) {
      const family = `${m[1]}-${m[2]}`; // bg-white / text-black etc.
      neutral.total++;
      bump(neutral.byTree, tree);
      bump(neutral.byFamily, family);
    }
  }
}

// ---- derived views --------------------------------------------------------
function sortObj(o) {
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const uniqueBaseSorted = Object.fromEntries(
  Object.entries(colored.uniqueBase).sort(
    (a, b) => a[1].family.localeCompare(b[1].family) || b[1].count - a[1].count || a[0].localeCompare(b[0]),
  ),
);

// per-family unique-string counts
const uniquePerFamily = {};
for (const [, v] of Object.entries(colored.uniqueBase)) {
  bump(uniquePerFamily, v.family);
}

// Aggregate "kiosk tree" grouping (display + lodge kiosk surfaces).
const KIOSK_TREES = [
  "kiosk-lodge-kiosk",
  "kiosk-display-route",
  "kiosk-lodge-display-components",
  "kiosk-lodge-display-lib",
];
const coloredKioskTotal = KIOSK_TREES.reduce((s, k) => s + (colored.byTree[k] || 0), 0);

// (authenticated)+(public) neutral subset (B4)
const neutralAuthPublic =
  (neutral.byTree["app-authenticated"] || 0) + (neutral.byTree["app-public"] || 0);

const result = {
  meta: {
    root: "src",
    filesScanned: files.length,
    prefixes: PREFIXES,
    colorFamilies: COLOR_FAMILIES,
    neutralFamilies: NEUTRAL_FAMILIES,
    note:
      "Occurrence = one Tailwind colour-utility token (variant prefixes stripped; /opacity suffix folded into the base string). Files under __tests__ excluded, TS/TSX only.",
  },
  colored: {
    total: colored.total,
    kioskAggregateTotal: coloredKioskTotal,
    byTree: sortObj(colored.byTree),
    byFamily: sortObj(colored.byFamily),
    uniqueBaseCount: Object.keys(colored.uniqueBase).length,
    familyCount: Object.keys(colored.byFamily).length,
    uniquePerFamily: sortObj(uniquePerFamily),
    uniqueBase: uniqueBaseSorted,
  },
  neutral: {
    total: neutral.total,
    authPublicSubset: neutralAuthPublic,
    byTree: sortObj(neutral.byTree),
    byFamily: sortObj(neutral.byFamily),
  },
};

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
}

// ---- headline stdout (deterministic) --------------------------------------
console.log("== COLORED colour-family utility occurrences ==");
console.log(`total:              ${colored.total}`);
console.log(`unique base strings: ${result.colored.uniqueBaseCount}`);
console.log(`colour families:     ${result.colored.familyCount}`);
console.log(`kiosk aggregate:     ${coloredKioskTotal}`);
console.log("by tree:");
for (const [k, v] of Object.entries(result.colored.byTree)) console.log(`  ${k.padEnd(34)} ${v}`);
console.log("by family:");
for (const [k, v] of Object.entries(result.colored.byFamily)) console.log(`  ${k.padEnd(12)} ${v}`);
console.log("\n== NEUTRAL raw utility occurrences ==");
console.log(`total:               ${neutral.total}`);
console.log(`(authenticated)+(public) subset: ${neutralAuthPublic}`);
console.log("by tree:");
for (const [k, v] of Object.entries(result.neutral.byTree)) console.log(`  ${k.padEnd(34)} ${v}`);
