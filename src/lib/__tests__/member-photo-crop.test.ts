import { describe, expect, it } from "vitest";
import {
  clampOffset,
  computeSourceRect,
  coverBaseScale,
} from "@/lib/member-photo-crop";

const VIEWPORT = 256;

describe("coverBaseScale", () => {
  it("scales by the shorter side of a landscape image so it covers the square", () => {
    // 800x400 landscape: height is the binding dimension.
    expect(coverBaseScale({ width: 800, height: 400 }, VIEWPORT)).toBeCloseTo(
      VIEWPORT / 400,
    );
  });

  it("scales by the shorter side of a portrait image", () => {
    expect(coverBaseScale({ width: 400, height: 800 }, VIEWPORT)).toBeCloseTo(
      VIEWPORT / 400,
    );
  });

  it("scales a square image to exactly cover", () => {
    expect(coverBaseScale({ width: 1000, height: 1000 }, VIEWPORT)).toBeCloseTo(
      VIEWPORT / 1000,
    );
  });

  it("returns a safe default for degenerate sizes", () => {
    expect(coverBaseScale({ width: 0, height: 0 }, VIEWPORT)).toBe(1);
    expect(coverBaseScale({ width: 100, height: 100 }, 0)).toBe(1);
  });
});

describe("clampOffset", () => {
  const natural = { width: 800, height: 400 };
  const scale = coverBaseScale(natural, VIEWPORT); // 0.64 -> disp 512x256

  it("keeps the covered viewport within the image (no exposed edge)", () => {
    // disp width 512, so x may range [256-512, 0] = [-256, 0].
    expect(clampOffset({ x: 100, y: 0 }, natural, VIEWPORT, scale).x).toBe(0);
    expect(clampOffset({ x: -1000, y: 0 }, natural, VIEWPORT, scale).x).toBe(
      -256,
    );
  });

  it("centres an axis whose display exactly matches the viewport", () => {
    // disp height == viewport (256), so y is pinned to 0 (centred).
    expect(clampOffset({ x: 0, y: 50 }, natural, VIEWPORT, scale).y).toBe(0);
  });

  it("centres defensively when the image is smaller than the viewport", () => {
    // Force a sub-viewport display via a tiny scale.
    const tiny = 0.1; // disp 80x40
    const result = clampOffset({ x: 0, y: 0 }, natural, VIEWPORT, tiny);
    expect(result.x).toBeCloseTo((VIEWPORT - 800 * tiny) / 2);
    expect(result.y).toBeCloseTo((VIEWPORT - 400 * tiny) / 2);
  });
});

describe("computeSourceRect", () => {
  const natural = { width: 800, height: 400 };
  const scale = coverBaseScale(natural, VIEWPORT); // 0.64

  it("maps a centred landscape crop to the middle square of the source", () => {
    // Centred: x offset -128 (disp 512 centred in 256), y 0.
    const rect = computeSourceRect(natural, VIEWPORT, scale, { x: -128, y: 0 });
    const side = VIEWPORT / scale; // 400
    expect(rect.sWidth).toBeCloseTo(side);
    expect(rect.sHeight).toBeCloseTo(side);
    expect(rect.sx).toBeCloseTo(128 / scale); // 200
    expect(rect.sy).toBeCloseTo(0);
  });

  it("clamps the source rect inside the image bounds against overshoot", () => {
    const rect = computeSourceRect(natural, VIEWPORT, scale, {
      x: -10000,
      y: 0,
    });
    const side = VIEWPORT / scale;
    expect(rect.sx).toBeCloseTo(natural.width - side); // 400
    expect(rect.sx + rect.sWidth).toBeLessThanOrEqual(natural.width + 1e-6);
  });

  it("produces a larger source rect at lower zoom (scale) — more of the image", () => {
    const zoomedOut = computeSourceRect(natural, VIEWPORT, scale, {
      x: -128,
      y: 0,
    });
    const zoomedIn = computeSourceRect(natural, VIEWPORT, scale * 2, {
      x: -256,
      y: 0,
    });
    expect(zoomedIn.sWidth).toBeLessThan(zoomedOut.sWidth);
  });
});
