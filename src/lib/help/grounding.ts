import { getHelpForPage } from "./index";
import type { HelpPageContent, HelpSurface } from "./types";

/**
 * Serialize the matched help entry for a page into readable labelled plain text.
 *
 * This is the SINGLE grounding source for the AI help route (epic #2094 C3): the
 * route builds its system/context grounding ONLY from this function's output,
 * derived entirely from the trusted server-side corpus keyed by (surface,
 * pathname). It must NEVER accept or embed client-supplied free text — any
 * client-provided page context belongs in the user turn, per the epic's security
 * resolution, never mixed into this grounding string. Pure string assembly, no
 * dependencies beyond the corpus lookup.
 */

function section(label: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return [`## ${label}`, ...lines, ""];
}

function serialize(content: HelpPageContent): string {
  const out: string[] = [];

  out.push(`# ${content.title}`, "");
  out.push(content.summary, "");

  out.push(...section("What you can do", content.actions.map((a) => `- ${a}`)));

  out.push(
    ...section(
      "Fields",
      (content.fields ?? []).map((f) => `- ${f.name}: ${f.description}`),
    ),
  );

  const sectionLines: string[] = [];
  for (const s of content.sections ?? []) {
    sectionLines.push(`${s.title}:`);
    for (const detail of s.details) {
      sectionLines.push(`  - ${detail}`);
    }
  }
  out.push(...section("Sections", sectionLines));

  out.push(...section("Notes", (content.notes ?? []).map((n) => `- ${n}`)));

  const qaLines: string[] = [];
  for (const question of content.questions ?? []) {
    qaLines.push(`Q: ${question.q}`);
    qaLines.push(`A: ${question.a}`);
    if (question.link) {
      qaLines.push(`Link: ${question.link.label} (${question.link.href})`);
    }
    if (question.group) {
      qaLines.push(`Applies to step: ${question.group}`);
    }
    qaLines.push("");
  }
  out.push(...section("Questions and answers", qaLines));

  return out.join("\n").trimEnd();
}

export function buildHelpGrounding(
  surface: HelpSurface,
  pathname: string,
): string {
  return serialize(getHelpForPage(surface, pathname));
}
