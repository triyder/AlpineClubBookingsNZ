"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { sanitiseEmailBodyHtml } from "@/lib/email-body-html";

/**
 * Rich in-place editor for admin email bodies (fork #38, owner decision
 * 25 Aug 2026: works like the /message-board composer). Follows
 * `club-post-editor.tsx`'s load-bearing patterns exactly — the sanitised
 * seed, selection saved on toolbar mousedown, and `styleWithCSS` false so
 * bold/italic/underline come out as tags the sanitiser allowlists rather
 * than style spans it would strip.
 *
 * WHAT THIS PRODUCES IS NOT TRUSTED: the server sanitises on save against
 * `email-body-html.ts` and again at render, and that policy is the control.
 * The toolbar deliberately offers only what the policy keeps —
 * bold/italic/underline, lists, alignment. No colours, fonts, sizes, images
 * or links: emails stay on the club theme in every mail client. `{{token}}`
 * markers are ordinary text in here; type them (or re-use the chips above
 * the editor) exactly as in the old plain editor.
 */
export function EmailBodyRichEditor({
  value,
  onChange,
  disabled,
  id,
  ariaLabel = "Email body",
}: {
  value: string;
  onChange: (html: string) => void;
  disabled: boolean;
  id?: string;
  /** Accessible name — a contentEditable div is not a labelable control, so
   * the visible <Label> cannot reach it via htmlFor; this carries the name. */
  ariaLabel?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  // The seed value the editor was mounted/reseeded with; innerHTML is only
  // written when the PARENT changes value (template switch, reset), never on
  // the editor's own keystrokes — rewriting innerHTML mid-edit moves the
  // caret to the start.
  const [seed, setSeed] = useState(() => sanitiseEmailBodyHtml(value));

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const safe = sanitiseEmailBodyHtml(value);
    if (editor.innerHTML !== safe && safe !== sanitiseEmailBodyHtml(editor.innerHTML)) {
      editor.innerHTML = safe;
      setSeed(safe);
    }
  }, [value]);

  const saveSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !savedRange.current) return;
    const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const usable =
      current &&
      !current.collapsed &&
      editor.contains(current.commonAncestorContainer);
    if (!usable) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
  }, []);

  const emit = useCallback(() => {
    onChange(editorRef.current?.innerHTML ?? "");
  }, [onChange]);

  const run = useCallback(
    (command: string) => {
      if (disabled) return;
      editorRef.current?.focus();
      restoreSelection();
      // styleWithCSS FALSE is load-bearing (see club-post-editor.tsx): as
      // tags (<b>, <i>, <u>) the formats survive the sanitiser's allowlist;
      // as style spans they would be stripped by our own policy.
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(command, false);
      emit();
    },
    [disabled, emit, restoreSelection],
  );

  const controls: Array<{ label: string; icon: React.ReactNode; command: string }> = [
    { label: "Bold", icon: <Bold className="h-4 w-4" />, command: "bold" },
    { label: "Italic", icon: <Italic className="h-4 w-4" />, command: "italic" },
    {
      label: "Underline",
      icon: <Underline className="h-4 w-4" />,
      command: "underline",
    },
    {
      label: "Bullet list",
      icon: <List className="h-4 w-4" />,
      command: "insertUnorderedList",
    },
    {
      label: "Numbered list",
      icon: <ListOrdered className="h-4 w-4" />,
      command: "insertOrderedList",
    },
    {
      label: "Align left",
      icon: <AlignLeft className="h-4 w-4" />,
      command: "justifyLeft",
    },
    {
      label: "Align centre",
      icon: <AlignCenter className="h-4 w-4" />,
      command: "justifyCenter",
    },
    {
      label: "Align right",
      icon: <AlignRight className="h-4 w-4" />,
      command: "justifyRight",
    },
  ];

  return (
    <div className="mt-1 rounded-md border">
      <div className="flex flex-wrap items-center gap-1 border-b p-1">
        {controls.map((control) => (
          <Button
            key={control.command}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2"
            aria-label={control.label}
            title={control.label}
            disabled={disabled}
            onMouseDown={(event) => {
              // Focus-stealing on mousedown collapses the selection before
              // click ever fires; preventing it keeps the caret in place.
              event.preventDefault();
              saveSelection();
              run(control.command);
            }}
          >
            {control.icon}
          </Button>
        ))}
        <span className="ml-1 text-xs text-muted-foreground">
          Styling shows as you type; tokens like {"{{firstName}}"} stay plain
          text.
        </span>
      </div>
      <div
        ref={editorRef}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className="min-h-72 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onInput={emit}
        onBlur={saveSelection}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        // The seed is ALWAYS the output of sanitiseEmailBodyHtml (mount and
        // every reseed above), the same policy the server enforces on save
        // and render — the club-post-editor precedent (#2992).
        dangerouslySetInnerHTML={{ __html: seed }} /* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
      />
    </div>
  );
}
