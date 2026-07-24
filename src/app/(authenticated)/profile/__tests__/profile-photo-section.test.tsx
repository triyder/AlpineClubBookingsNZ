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

import { ProfilePhotoSection } from "@/app/(authenticated)/profile/profile-photo-section";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfilePhotoSection", () => {
  it("shows initials and an Add photo action when the member has no photo", () => {
    render(
      <ProfilePhotoSection
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={false}
        initialPhotoVersion={null}
      />,
    );

    expect(screen.getByText("AL")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add photo/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("renders the current photo from the scoped, cache-busted serving URL", () => {
    render(
      <ProfilePhotoSection
        memberId="mem-42"
        memberName="Ada Lovelace"
        initialHasPhoto={true}
        initialPhotoVersion="2026-07-17T00:00:00.000Z"
      />,
    );

    const img = screen.getByAltText("Ada Lovelace's profile photo") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "/api/members/mem-42/photo?v=2026-07-17T00%3A00%3A00.000Z",
    );
    expect(img.getAttribute("src")).not.toContain("/api/images");
    expect(screen.getByRole("button", { name: /change photo/i })).toBeTruthy();
  });

  it("removes the photo via a DELETE to the scoped endpoint and updates the UI", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    render(
      <ProfilePhotoSection
        memberId="mem-7"
        memberName="Ada Lovelace"
        initialHasPhoto={true}
        initialPhotoVersion="v1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    // Confirm dialog appears.
    const confirm = await screen.findByRole("button", {
      name: /remove photo/i,
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/members/mem-7/photo");
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.refresh).toHaveBeenCalled();
    // Photo replaced by the initials placeholder.
    await waitFor(() => expect(screen.getByText("AL")).toBeTruthy());
  });

  it("rejects a non-image file client-side without opening the crop dialog", () => {
    const { container } = render(
      <ProfilePhotoSection
        memberId="mem-1"
        memberName="Ada Lovelace"
        initialHasPhoto={false}
        initialPhotoVersion={null}
      />,
    );

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const badFile = new File(["not an image"], "notes.txt", {
      type: "text/plain",
    });
    fireEvent.change(input, { target: { files: [badFile] } });

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringMatching(/JPEG, PNG or WebP/i),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/frame your photo/i)).toBeNull();
  });
});
