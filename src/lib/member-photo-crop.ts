/**
 * Pure geometry for the member-photo crop UI (epic #171, MP3).
 *
 * Factored out of the client component so the mapping from the on-screen
 * viewport (a square framing the circular guide) to the source rectangle in the
 * natural image can be unit-tested without a real canvas — jsdom has none. The
 * component draws the preview and the export canvas from the SAME values these
 * functions produce, so what the member frames is exactly what is uploaded.
 *
 * Coordinate model: the image is scaled by `scale` and its top-left placed at
 * `offset` (viewport pixels). `scale = coverBaseScale(...) * zoom`, zoom >= 1,
 * so at zoom 1 the image exactly covers the viewport and can only be panned
 * within its own bounds.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Offset {
  readonly x: number;
  readonly y: number;
}

export interface SourceRect {
  readonly sx: number;
  readonly sy: number;
  readonly sWidth: number;
  readonly sHeight: number;
}

/**
 * Smallest scale at which `natural` fully covers a `viewport`x`viewport` square
 * (object-fit: cover). Multiplying by a zoom factor >= 1 keeps coverage.
 */
export function coverBaseScale(natural: Size, viewport: number): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport <= 0) {
    return 1;
  }
  return Math.max(viewport / natural.width, viewport / natural.height);
}

/**
 * Clamp `offset` so the scaled image never exposes an edge inside the viewport
 * (the square must stay fully covered). Display size = natural * scale; valid
 * offset for each axis is [viewport - displaySize, 0].
 */
export function clampOffset(
  offset: Offset,
  natural: Size,
  viewport: number,
  scale: number,
): Offset {
  const dispW = natural.width * scale;
  const dispH = natural.height * scale;
  // If (defensively) the image is smaller than the viewport on an axis, centre
  // it rather than allowing a gap.
  const minX = viewport - dispW;
  const minY = viewport - dispH;
  const clamp = (value: number, min: number) =>
    min >= 0 ? min / 2 : Math.min(0, Math.max(min, value));
  return { x: clamp(offset.x, minX), y: clamp(offset.y, minY) };
}

/**
 * Map the covered viewport square back to a source rectangle in natural-image
 * pixels. The export canvas draws this rect into an `output`x`output` square,
 * so the stored image is the square bounding box of the circular guide (display
 * crops to a circle via CSS). Result is clamped into the image bounds to guard
 * against sub-pixel drift producing an out-of-range draw.
 */
export function computeSourceRect(
  natural: Size,
  viewport: number,
  scale: number,
  offset: Offset,
): SourceRect {
  const side = viewport / scale;
  let sx = -offset.x / scale;
  let sy = -offset.y / scale;
  // Guard against tiny overshoot beyond the image bounds.
  sx = Math.min(Math.max(0, sx), Math.max(0, natural.width - side));
  sy = Math.min(Math.max(0, sy), Math.max(0, natural.height - side));
  return { sx, sy, sWidth: side, sHeight: side };
}
