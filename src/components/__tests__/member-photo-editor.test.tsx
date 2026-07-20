// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
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

  it("treats the loading tri-state (canEdit undefined) as read-only", () => {
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

    expect(screen.queryByRole("button", { name: /add photo/i })).toBeNull();
    expect(fileInput(container)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
