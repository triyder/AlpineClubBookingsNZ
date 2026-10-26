// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useRef } from "react";
import {
  expectRevealed,
  expectToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "../use-section-edit-state";

interface Draft {
  minGroupSize: number;
  enabled: boolean;
}

const INITIAL: Draft = { minGroupSize: 5, enabled: false };

function renderSection(
  overrides: Partial<Parameters<typeof useSectionEditState<Draft>>[0]> = {},
) {
  const save = vi.fn(async (draft: Draft) => draft);
  const view = renderHook(() =>
    useSectionEditState<Draft>({
      initial: INITIAL,
      save,
      successMessage: "Saved",
      ...overrides,
    }),
  );
  return { ...view, save };
}

afterEach(() => {
  cleanup();
});

/** Operate a control the way a keyboard user does: it holds focus first. */
function activate(control: HTMLElement) {
  control.focus();
  fireEvent.click(control);
}

interface StagedSectionProps {
  title: string;
  save?: (draft: Draft) => Promise<Draft>;
  /** The Edit control is rendered while read-only (a view-only card may hide it). */
  showEdit?: boolean;
  /** The Edit control is rendered disabled (a view-only admin). */
  editDisabled?: boolean;
}

/**
 * The canonical staged section's shape: Edit renders only while read-only, and
 * Save/Cancel only while editing, so every transition unmounts the button that
 * was just pressed. Save is disabled while saving, as every adopter's is.
 */
function StagedSection({
  title,
  save = async (draft) => draft,
  showEdit = true,
  editDisabled = false,
}: StagedSectionProps) {
  const section = useSectionEditState<Draft>({
    initial: INITIAL,
    save,
    successMessage: "Saved",
    allowPristineSave: true,
  });
  // The real card primitives: `CardTitle` renders a `div`, not a heading, so
  // the region's name has to come from `titleProps`, not a heading lookup.
  return (
    <Card {...section.sectionRegionProps}>
      <CardHeader>
        <CardTitle {...section.titleProps}>{title}</CardTitle>
        {!section.editing && showEdit ? (
          <button
            type="button"
            disabled={editDisabled}
            onClick={section.startEditing}
            {...section.editTriggerProps}
          >
            Edit {title}
          </button>
        ) : null}
      </CardHeader>
      <CardContent>
        {/* A row heading the name must NOT be taken from. */}
        <h4>Row one</h4>
      </CardContent>
      {section.error ? <p role="alert">{section.error}</p> : null}
      {section.editing ? (
        <div>
          {/* Mounted by Edit, so Edit's reveal lands here (#4115). */}
          <input aria-label={`${title} size`} />
          <button
            type="button"
            disabled={section.saving}
            onClick={() => void section.save()}
          >
            Save {title}
          </button>
          <button type="button" onClick={section.cancelEditing}>
            Cancel {title}
          </button>
        </div>
      ) : null}
    </Card>
  );
}

describe("useSectionEditState", () => {
  it("seeds draft and snapshot from `initial` and starts read-only", () => {
    const { result } = renderSection();

    expect(result.current.draft).toEqual(INITIAL);
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("stages draft edits without touching the snapshot", () => {
    const { result } = renderSection();

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9 }));

    expect(result.current.draft).toEqual({ minGroupSize: 9, enabled: false });
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.dirty).toBe(true);
  });

  it("restores EVERY field from the snapshot on cancel", () => {
    const { result } = renderSection();

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9, enabled: true }));
    act(() => result.current.cancelEditing());

    expect(result.current.draft).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("re-seeds draft AND snapshot from the server response, not the draft", async () => {
    // The server clamps the submitted value; both draft and snapshot must end
    // up showing what the server actually stored.
    const save = vi.fn(async () => ({ minGroupSize: 20, enabled: true }));
    const { result } = renderSection({ save });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 999, enabled: true }));
    await act(async () => {
      await result.current.save();
    });

    expect(save).toHaveBeenCalledWith(
      { minGroupSize: 999, enabled: true },
      INITIAL,
    );
    expect(result.current.draft).toEqual({ minGroupSize: 20, enabled: true });
    expect(result.current.saved).toEqual({ minGroupSize: 20, enabled: true });
    expect(result.current.dirty).toBe(false);
    expect(result.current.editing).toBe(false);
    expect(result.current.success).toBe("Saved");
  });

  it("computes the success message from the saved value when it is conditional", async () => {
    const { result } = renderSection({
      successMessage: (saved) => (saved.enabled ? "On." : "Off."),
    });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ enabled: true }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.success).toBe("On.");
  });

  it("maps ForbiddenSaveError to the shared 403 copy and stays in edit mode", async () => {
    const save = vi.fn(async () => {
      throw new ForbiddenSaveError();
    });
    const { result } = renderSection({ save });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.error).toBe(ADMIN_FORBIDDEN_SAVE_REASON);
    expect(result.current.success).toBe("");
    expect(result.current.editing).toBe(true);
    // The rejected draft is retained so the admin does not lose their edit.
    expect(result.current.draft).toEqual({ minGroupSize: 9, enabled: false });
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.saving).toBe(false);
  });

  it("surfaces a save error message and falls back for a non-Error throw", async () => {
    const failing = renderSection({
      save: vi.fn(async () => {
        throw new Error("Boom");
      }),
    });
    failing.result.current.startEditing();
    act(() => failing.result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await failing.result.current.save();
    });
    expect(failing.result.current.error).toBe("Boom");

    const odd = renderSection({
      save: vi.fn(async () => {
        throw "nope";
      }),
      saveErrorFallback: "Could not save",
    });
    act(() => odd.result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await odd.result.current.save();
    });
    expect(odd.result.current.error).toBe("Could not save");
  });

  it("clears both messages when a save starts", async () => {
    const { result } = renderSection();

    act(() => result.current.setError("stale error"));
    act(() => result.current.setSuccess("stale success"));
    act(() => result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.error).toBe("");
    expect(result.current.success).toBe("Saved");
  });

  it("skips a pristine save by default and allows one when opted in", async () => {
    const guarded = renderSection();
    await act(async () => {
      await guarded.result.current.save();
    });
    expect(guarded.save).not.toHaveBeenCalled();

    // `allowPristineSave` has no adopter (#2143 removed the last one) but is
    // retained as an escape hatch for a future card whose endpoint is an action
    // rather than a state update. Pinning it here keeps the opt-in honest, so
    // whoever reaches for it gets the behaviour the option advertises.
    const pristine = renderSection({ allowPristineSave: true });
    await act(async () => {
      await pristine.result.current.save();
    });
    expect(pristine.save).toHaveBeenCalledTimes(1);
  });

  it("blocks a save while the draft is invalid", async () => {
    const { result, save } = renderSection({
      isValid: (draft) => draft.minGroupSize >= 2,
    });

    act(() => result.current.setDraft({ minGroupSize: 1 }));
    expect(result.current.valid).toBe(false);
    await act(async () => {
      await result.current.save();
    });
    expect(save).not.toHaveBeenCalled();

    act(() => result.current.setDraft({ minGroupSize: 4 }));
    expect(result.current.valid).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("honours a custom dirty comparator for non-scalar drafts", () => {
    interface ListDraft {
      rules: number[];
    }
    const { result } = renderHook(() =>
      useSectionEditState<ListDraft>({
        initial: { rules: [1, 2] },
        save: async (draft) => draft,
        successMessage: "Saved",
        isDirty: (draft, saved) =>
          JSON.stringify(draft.rules) !== JSON.stringify(saved.rules),
      }),
    );

    // A fresh array with equal contents is a new reference: the default
    // shallow check would call this dirty, the deep comparator does not.
    act(() => result.current.setDraft({ rules: [1, 2] }));
    expect(result.current.dirty).toBe(false);

    act(() => result.current.setDraft({ rules: [1, 3] }));
    expect(result.current.dirty).toBe(true);
  });

  describe("with a load step", () => {
    it("loads once on mount, then exposes the loaded value", async () => {
      const load = vi.fn(async () => ({ minGroupSize: 8, enabled: true }));
      const { result } = renderHook(() =>
        useSectionEditState<Draft>({
          load,
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      // Nothing to render until the fetch resolves.
      expect(result.current.loading).toBe(true);
      expect(result.current.draft).toBeNull();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.current.draft).toEqual({ minGroupSize: 8, enabled: true });
      expect(result.current.saved).toEqual({ minGroupSize: 8, enabled: true });
    });

    it("loads exactly once across re-renders with a fresh inline `load`", async () => {
      // Every adopter passes a NON-memoised inline arrow for `load`, so its
      // identity changes on every render. The hook holds callbacks in a
      // latest-ref precisely so the mount effect can depend on the stable
      // `runLoad` instead. Widening those deps back to `options.load` would
      // refetch on every render — a fetch loop on `/admin/booking-policies` and
      // `/admin/security` — which this rerender is here to catch.
      const load = vi.fn(async (_signal: AbortSignal) => ({
        minGroupSize: 8,
        enabled: true,
      }));
      const { result, rerender } = renderHook(() =>
        useSectionEditState<Draft>({
          // A brand-new arrow identity on every render, as the cards do.
          load: (signal) => load(signal),
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(load).toHaveBeenCalledTimes(1);

      rerender();
      rerender();
      // A state change re-renders too, and must not re-trigger the load.
      act(() => result.current.startEditing());

      await waitFor(() => expect(result.current.editing).toBe(true));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("keeps the seeded draft visible when the load fails", async () => {
      const { result } = renderSection({
        load: vi.fn(async () => {
          throw new Error("Failed to fetch");
        }),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe("Failed to fetch");
      expect(result.current.draft).toEqual(INITIAL);
    });

    it("swallows an AbortError from an in-flight load", async () => {
      const { result } = renderSection({
        load: vi.fn(async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe("");
    });

    it("reload clears both messages and re-fetches", async () => {
      const load = vi
        .fn<() => Promise<Draft>>()
        .mockResolvedValueOnce({ minGroupSize: 8, enabled: true })
        .mockResolvedValueOnce({ minGroupSize: 3, enabled: false });
      const { result } = renderHook(() =>
        useSectionEditState<Draft>({
          load,
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.setSuccess("stale"));
      act(() => result.current.startEditing());

      await act(async () => {
        await result.current.reload();
      });

      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.draft).toEqual({ minGroupSize: 3, enabled: false });
      expect(result.current.success).toBe("");
      // Reloading drops back to read-only, discarding any in-flight edit.
      expect(result.current.editing).toBe(false);
    });
  });

  describe("returning focus when the editor closes (#4087)", () => {
    const button = (name: string) => screen.getByRole("button", { name });

    it("hands focus back to the re-rendered Edit button after Cancel", async () => {
      render(<StagedSection title="Discount" />);

      activate(button("Edit Discount"));
      activate(button("Cancel Discount"));

      // Cancel unmounted the button that held focus; without the return a
      // keyboard user is left on <body>.
      await expectToHoldFocus(button("Edit Discount"));
    });

    it("hands focus back to the Edit button after a successful Save", async () => {
      render(<StagedSection title="Discount" />);

      activate(button("Edit Discount"));
      activate(button("Save Discount"));

      await expectToHoldFocus(
        await screen.findByRole("button", { name: "Edit Discount" }),
      );
      expect(screen.queryByRole("button", { name: "Save Discount" })).toBeNull();
    });

    it("gives focus back to the re-enabled Save when a failed save dropped it", async () => {
      // A browser drops focus from a control that becomes disabled; jsdom does
      // not, so the save does what the browser would while it is in flight.
      const save = vi.fn(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        throw new Error("Rejected");
      });
      render(<StagedSection title="Discount" save={save} />);

      activate(button("Edit Discount"));
      const saveButton = button("Save Discount");
      activate(saveButton);

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe("Rejected"),
      );
      // Edit mode stays open and the control the admin pressed has it back.
      await expectToHoldFocus(saveButton);
      expect(screen.queryByRole("button", { name: "Edit Discount" })).toBeNull();

      // The edit anchor survived the failure: Cancel still returns to Edit.
      activate(button("Cancel Discount"));
      await expectToHoldFocus(button("Edit Discount"));
    });

    it("leaves a failed save's focus alone when it was never dropped", async () => {
      const save = vi.fn(async () => {
        throw new Error("Rejected");
      });
      render(<StagedSection title="Discount" save={save} />);

      activate(button("Edit Discount"));
      const saveButton = button("Save Discount");
      activate(saveButton);
      const elsewhere = button("Cancel Discount");
      elsewhere.focus();

      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      await expectToHoldFocus(elsewhere);
    });

    it("falls back to the section, named by its title, when Edit comes back disabled (view-only)", async () => {
      const view = render(<StagedSection title="Discount" />);

      activate(button("Edit Discount"));
      // Permissions narrowed while the editor was open.
      view.rerender(<StagedSection title="Discount" editDisabled />);
      activate(button("Cancel Discount"));

      await expectToHoldFocus(screen.getByRole("region", { name: "Discount" }));
    });

    it("names the card a region by its own title, declaratively, from the first render", () => {
      render(<StagedSection title="Discount" />);

      const region = screen.getByRole("region", { name: "Discount" });
      // Named by the CardTitle (a div), not by the row's h4, and before any
      // return has run — nothing is written into the DOM later.
      expect(region.getAttribute("aria-labelledby")).toBe(
        screen.getByText("Discount").id,
      );
      expect(screen.queryByRole("region", { name: "Row one" })).toBeNull();
    });

    it("names a card with no visible title by its regionLabel", () => {
      function Untitled() {
        const section = useSectionEditState<Draft>({
          initial: INITIAL,
          save: async (draft) => draft,
          successMessage: "Saved",
          regionLabel: "Club identity",
        });
        return <div {...section.sectionRegionProps} />;
      }
      render(<Untitled />);

      const region = screen.getByRole("region", { name: "Club identity" });
      expect(region.hasAttribute("aria-labelledby")).toBe(false);
    });

    it("falls back to the section when it no longer renders Edit", async () => {
      const view = render(<StagedSection title="Discount" />);

      activate(button("Edit Discount"));
      view.rerender(<StagedSection title="Discount" showEdit={false} />);
      activate(button("Cancel Discount"));

      await expectToHoldFocus(screen.getByRole("region", { name: "Discount" }));
    });

    it("returns each of two sections open at once to its OWN Edit", async () => {
      render(
        <>
          <StagedSection title="First" />
          <StagedSection title="Second" />
        </>,
      );

      activate(button("Edit First"));
      activate(button("Edit Second"));

      // First closes first, so when Second closes BOTH Edit controls are on
      // the page and only Second's own marker picks the right one.
      activate(button("Cancel First"));
      await expectToHoldFocus(button("Edit First"));

      activate(button("Cancel Second"));
      await expectToHoldFocus(button("Edit Second"));
    });

    it("finds this section's Edit by its marker, not by its name", async () => {
      // Two Edit controls with IDENTICAL names: only the per-instance marker
      // tells them apart.
      function SameName({ marker }: { marker: string }) {
        const section = useSectionEditState<Draft>({
          initial: INITIAL,
          save: async (draft) => draft,
          successMessage: "Saved",
        });
        // Cancel sits in a wrapper so React cannot reuse the Edit's DOM node
        // for it: the Edit after Cancel is a NEW element, as in every section.
        return section.editing ? (
          <span>
            <button type="button" onClick={section.cancelEditing}>
              Cancel {marker}
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid={marker}
            onClick={section.startEditing}
            {...section.editTriggerProps}
          >
            Edit
          </button>
        );
      }
      render(
        <div>
          <SameName marker="first" />
          <SameName marker="second" />
        </div>,
      );

      activate(screen.getByTestId("second"));
      activate(button("Cancel second"));

      await expectToHoldFocus(screen.getByTestId("second"));
    });

    it("leaves focus alone when the admin has already moved it", async () => {
      render(
        <>
          <StagedSection title="Discount" />
          <input aria-label="Elsewhere" />
        </>,
      );

      activate(button("Edit Discount"));
      const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
      elsewhere.focus();
      // A pointer press on Cancel that never moved focus.
      fireEvent.click(button("Cancel Discount"));

      await expectToHoldFocus(elsewhere);
    });

    it("still returns to Edit when it was opened with nothing focused", async () => {
      render(<StagedSection title="Discount" />);

      // Mouse clicks in a browser that does not focus buttons; then the close
      // drops focus to the page all the same.
      fireEvent.click(button("Edit Discount"));
      fireEvent.click(button("Cancel Discount"));

      await expectToHoldFocus(button("Edit Discount"));
    });
  });

  describe("revealing the editor when Edit opens it (#4115)", () => {
    const button = (name: string) => screen.getByRole("button", { name });

    /**
     * The usual staged-section shape: the fields are always rendered and Edit
     * enables them, while a scope select above them stays editable throughout.
     */
    function FieldsSection({ fields = true }: { fields?: boolean }) {
      const section = useSectionEditState<Draft>({
        initial: INITIAL,
        save: async (draft) => draft,
        successMessage: "Saved",
      });
      const off = !section.editing;
      return (
        <Card {...section.sectionRegionProps}>
          <CardHeader>
            <CardTitle {...section.titleProps}>Group discount</CardTitle>
            <select aria-label="Scope">
              <option>Club-wide</option>
            </select>
            {off ? (
              <button
                type="button"
                onClick={section.startEditing}
                {...section.editTriggerProps}
              >
                Edit
              </button>
            ) : (
              <button type="button" onClick={section.cancelEditing}>
                Cancel
              </button>
            )}
          </CardHeader>
          {fields ? (
            <CardContent>
              {/* What a Radix checkbox renders: the widget and a hidden input. */}
              <button type="button" role="checkbox" aria-checked="false" aria-label="Enabled" disabled={off} />
              <input type="checkbox" aria-hidden="true" tabIndex={-1} disabled={off} />
              <input aria-label="Minimum group size" disabled={off} />
            </CardContent>
          ) : null}
        </Card>
      );
    }

    it("focuses the first control Edit made editable, not one that already was", async () => {
      render(<FieldsSection />);
      // Rendering the section moves nothing.
      expect(document.activeElement).toBe(document.body);

      activate(button("Edit"));

      await expectToHoldFocus(screen.getByRole("checkbox", { name: "Enabled" }));
    });

    it("focuses a control Edit mounted", async () => {
      render(<StagedSection title="Discount" />);

      activate(button("Edit Discount"));

      await expectToHoldFocus(screen.getByRole("textbox", { name: "Discount size" }));
    });

    it("focuses the section, named by its title, when Edit made nothing editable", async () => {
      render(<FieldsSection fields={false} />);

      activate(button("Edit"));

      await expectToHoldFocus(
        screen.getByRole("region", { name: "Group discount" }),
      );
    });

    it("moves nothing when the open editor merely re-renders", async () => {
      const view = render(<FieldsSection />);
      activate(button("Edit"));
      await expectToHoldFocus(screen.getByRole("checkbox", { name: "Enabled" }));

      const scope = screen.getByRole("combobox", { name: "Scope" });
      scope.focus();
      view.rerender(<FieldsSection />);

      await expectToHoldFocus(scope);
    });

    it("reveals each section's OWN editor", async () => {
      render(
        <>
          <StagedSection title="First" />
          <StagedSection title="Second" />
        </>,
      );

      activate(button("Edit Second"));

      await expectToHoldFocus(screen.getByRole("textbox", { name: "Second size" }));
    });

    it("reveals the given element at the top instead, for a section that names one", async () => {
      const scrollIntoView = installScrollIntoViewSpy();
      try {
        function Targeted() {
          const cardRef = useRef<HTMLDivElement>(null);
          const section = useSectionEditState<Draft>({
            initial: INITIAL,
            save: async (draft) => draft,
            successMessage: "Saved",
            revealTarget: cardRef,
          });
          return (
            <div {...section.sectionRegionProps} aria-label="Targeted">
              <div ref={cardRef} data-testid="target">
                {section.editing ? (
                  <input aria-label="Size" />
                ) : (
                  <button type="button" onClick={section.startEditing}>
                    Edit
                  </button>
                )}
              </div>
            </div>
          );
        }
        const view = render(<Targeted />);
        activate(button("Edit"));

        const target = screen.getByTestId("target");
        await waitFor(() => expect(document.activeElement).toBe(target));
        // One reveal, of the target, and not of the field the edit mounted.
        expectRevealed(scrollIntoView, target);

        view.rerender(<Targeted />);
        expectRevealed(scrollIntoView, target);
      } finally {
        removeScrollIntoViewSpy();
      }
    });
  });
});
