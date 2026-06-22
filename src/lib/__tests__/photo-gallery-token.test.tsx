// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoGalleryToken } from "@/components/website/photo-gallery-token";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  destroy: vi.fn(),
  loadAndOpen: vi.fn(),
  on: vi.fn(),
}));

vi.mock("@/lib/photoswipe-lightbox", () => ({
  default: vi.fn().mockImplementation(function PhotoSwipeLightboxMock() {
    return {
      init: mocks.init,
      destroy: mocks.destroy,
      loadAndOpen: mocks.loadAndOpen,
      on: mocks.on,
    };
  }),
  loadPhotoSwipeModule: vi.fn(),
}));

describe("PhotoGalleryToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not auto-open the slideshow lightbox on page load", async () => {
    render(
      <PhotoGalleryToken
        galleryId="slideshow"
        variant="slideshow"
        images={[
          {
            src: "/api/images/photo-1",
            alt: "Lodge",
            width: 1200,
            height: 800,
          },
        ]}
      />,
    );

    await waitFor(() => expect(mocks.init).toHaveBeenCalled());
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();
  });
});
