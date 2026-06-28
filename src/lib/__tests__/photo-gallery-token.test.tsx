// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    frameCallbacks = new Map();
    nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frameCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runAnimationFrames = () => {
    const callbacks = Array.from(frameCallbacks.values());
    frameCallbacks.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };

  it("auto-opens the slideshow lightbox after an animation frame", async () => {
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

    runAnimationFrames();

    expect(mocks.loadAndOpen).toHaveBeenCalledTimes(1);
    expect(mocks.loadAndOpen).toHaveBeenCalledWith(0, {
      gallery: document.getElementById("slideshow"),
    });
  });

  it("does not auto-open ordinary gallery tokens", async () => {
    render(
      <PhotoGalleryToken
        galleryId="gallery"
        variant="gallery"
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

    runAnimationFrames();

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();
  });

  it("cancels a pending slideshow auto-open on unmount", async () => {
    const { unmount } = render(
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

    unmount();
    runAnimationFrames();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();
  });
});
