// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
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
});
