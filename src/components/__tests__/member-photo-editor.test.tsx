// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { MemberPhotoEditor } from "@/components/member-photo-editor";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fileInput(container: HTMLElement) {
  return container.querySelector('input[type="file"]');
}

describe("MemberPhotoEditor — admin view-only gating", () => {
  it("an editing admin sees the manage controls, the consent note, and admin copy", () => {
    render(
      <MemberPhotoEditor
        mode="admin"
        canEdit={true}
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={true}
        initialPhotoVersion="v1"
      />,
    );

    expect(screen.getByRole("button", { name: /change photo/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeTruthy();
    // Admin third-person visibility copy + the on-behalf consent note.
    expect(screen.getByText(/shown to the member/i)).toBeTruthy();
    expect(screen.getByText(/on the member's behalf/i)).toBeTruthy();
  });

  it("a read-only admin (canEdit false) sees the photo but no controls, and a hint", () => {
    const { container } = render(
      <MemberPhotoEditor
        mode="admin"
        canEdit={false}
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={true}
        initialPhotoVersion="v1"
      />,
    );

    // The photo still renders.
    expect(
      screen.getByAltText("Ada Lovelace's profile photo"),
    ).toBeTruthy();
    // No mutate controls, no file input, and a view-only hint.
    expect(screen.queryByRole("button", { name: /change photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(fileInput(container)).toBeNull();
    expect(screen.getByText(/view-only access to membership/i)).toBeTruthy();
    // No consent note when the admin cannot act.
    expect(screen.queryByText(/on the member's behalf/i)).toBeNull();
  });

  it("treats the loading tri-state (canEdit undefined) as read-only with no message (anti-flash)", () => {
    const { container } = render(
      <MemberPhotoEditor
        mode="admin"
        canEdit={undefined}
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={false}
        initialPhotoVersion={null}
      />,
    );

    // No controls are enabled while permission is resolving...
    expect(screen.queryByRole("button", { name: /add photo/i })).toBeNull();
    expect(fileInput(container)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // ...and, unlike canEdit === false, no definitive read-only message is
    // shown, so an edit-capable admin never sees a false "you cannot change
    // this" flash before controls resolve in.
    expect(screen.queryByText(/view-only access to membership/i)).toBeNull();
    expect(
      screen.queryByText(/do not have permission to change this photo/i),
    ).toBeNull();
  });

  it("self mode shows first-person copy and no admin consent note", () => {
    // The profile wrapper always passes canEdit — a member may edit their own.
    render(
      <MemberPhotoEditor
        mode="self"
        canEdit={true}
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={false}
        initialPhotoVersion={null}
      />,
    );

    expect(screen.getByRole("button", { name: /add photo/i })).toBeTruthy();
    expect(screen.getByText(/your photo is shown to you/i)).toBeTruthy();
    expect(screen.queryByText(/on the member's behalf/i)).toBeNull();
  });
});

describe("MemberPhotoEditor — cropper keyboard accessibility (M2)", () => {
  // The crop canvas is only mounted once an image has been selected and
  // decoded. jsdom has no real Image or 2D canvas, so we stub both: setting
  // `src` fires onload with a wide natural size (giving horizontal pan room at
  // zoom 1), and getContext records the offset the draw effect paints with.
  const drawCalls: Array<{ offsetX: number; offsetY: number }> = [];
  let realImage: typeof Image;
  let realGetContext: typeof HTMLCanvasElement.prototype.getContext;
  const urlAny = URL as any;
  const realCreateObjectURL = urlAny.createObjectURL;
  const realRevokeObjectURL = urlAny.revokeObjectURL;

  beforeEach(() => {
    drawCalls.length = 0;
    realImage = globalThis.Image;
    realGetContext = HTMLCanvasElement.prototype.getContext;

    urlAny.createObjectURL = vi.fn(() => "blob:mock");
    urlAny.revokeObjectURL = vi.fn();

    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 512;
      naturalHeight = 256;
      width = 0;
      height = 0;
      #src = "";
      set src(value: string) {
        this.#src = value;
        // Decode completes on the next microtask.
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.#src;
      }
    }
    globalThis.Image = MockImage as any;

    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      drawImage: (
        _img: unknown,
        offsetX: number,
        offsetY: number,
      ) => {
        drawCalls.push({ offsetX, offsetY });
      },
    })) as any;
  });

  afterEach(() => {
    globalThis.Image = realImage;
    HTMLCanvasElement.prototype.getContext = realGetContext;
    urlAny.createObjectURL = realCreateObjectURL;
    urlAny.revokeObjectURL = realRevokeObjectURL;
  });

  async function openCropper() {
    const { container } = render(
      <MemberPhotoEditor
        mode="self"
        canEdit={true}
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={false}
        initialPhotoVersion={null}
      />,
    );
    const input = fileInput(container) as HTMLInputElement;
    const file = new File(["x"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    // The canvas mounts inside the Radix dialog, which portals to document.body.
    const canvas = await waitFor(() => {
      const el = document.querySelector("canvas");
      if (!el) throw new Error("canvas not mounted yet");
      return el as HTMLCanvasElement;
    });
    return { container, canvas };
  }

  it("makes the crop canvas focusable (tabIndex 0) with an arrow-key affordance in its label", async () => {
    const { canvas } = await openCropper();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute("aria-label")).toMatch(/arrow keys/i);
  });

  it("pans the crop offset when an arrow key is pressed", async () => {
    const { canvas } = await openCropper();
    // Wait for the initial draw so we have a baseline offset.
    await waitFor(() => expect(drawCalls.length).toBeGreaterThan(0));
    const before = drawCalls[drawCalls.length - 1]!.offsetX;

    // ArrowLeft nudges the wide image left (there is pan room on the X axis).
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });

    await waitFor(() => {
      const after = drawCalls[drawCalls.length - 1]!.offsetX;
      expect(after).toBeLessThan(before);
    });
  });
});
