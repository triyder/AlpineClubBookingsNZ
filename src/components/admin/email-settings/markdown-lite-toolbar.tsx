"use client";

import type { RefObject } from "react";
import { Bold, Heading2, Italic, List } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The markdown-lite formatting toolbar for the email body editor (fork #38).
 *
 * Each button edits the PLAIN TEXT at the textarea's cursor — storage stays
 * text and the renderer applies the vocabulary at send time, so this
 * component owns no formatting semantics beyond inserting the markers. Own
 * file so the already-over-budget settings panel does not grow by the
 * toolbar's length.
 */
export function MarkdownLiteToolbar({
  textareaRef,
  value,
  onChange,
  disabled,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  // Wrap the current selection in inline markers (Bold/Italic). With nothing
  // selected, a placeholder is inserted ready to type over.
  function wrapSelection(prefix: string, suffix: string, placeholder: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || placeholder;
    onChange(
      value.slice(0, start) + prefix + selected + suffix + value.slice(end),
    );
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length,
      );
    });
  }

  // Prefix every line the selection touches (Heading/Bullet). Pressing the
  // button again removes the prefix, so it works as a toggle.
  function prefixLines(prefix: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const allPrefixed = lines.every((line) => line.startsWith(prefix));
    const nextLines = lines.map((line) =>
      allPrefixed ? line.slice(prefix.length) : prefix + line,
    );
    onChange(
      value.slice(0, lineStart) + nextLines.join("\n") + value.slice(lineEnd),
    );
    requestAnimationFrame(() => {
      textarea.focus();
      const delta = nextLines.join("\n").length - (lineEnd - lineStart);
      textarea.setSelectionRange(lineStart, lineEnd + delta);
    });
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label="Bold (wraps the selection in **)"
        title="Bold"
        onClick={() => wrapSelection("**", "**", "bold text")}
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label="Italic (wraps the selection in *)"
        title="Italic"
        onClick={() => wrapSelection("*", "*", "italic text")}
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label="Heading (starts the line with #)"
        title="Heading"
        onClick={() => prefixLines("# ")}
      >
        <Heading2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label="Bullet list (starts each selected line with a dash)"
        title="Bullet list"
        onClick={() => prefixLines("- ")}
      >
        <List className="h-4 w-4" />
      </Button>
      <span className="ml-1 text-xs text-muted-foreground">
        **bold**, *italic*, # heading and - bullets render styled; use Preview
        to see the result.
      </span>
    </div>
  );
}
