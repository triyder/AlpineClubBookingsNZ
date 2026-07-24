"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Loader2, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { memberPhotoServingUrl } from "@/lib/member-photo-url";
import {
  clampOffset,
  computeSourceRect,
  coverBaseScale,
  type Offset,
  type Size,
} from "@/lib/member-photo-crop";

const VIEWPORT = 256;
const OUTPUT = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
// The upload endpoint (MP2) re-encodes and enforces the real caps; these are
// friendly client-side pre-checks so the user is told immediately rather than
// after a failed round-trip. The source cap is generous because the crop is
// downscaled to OUTPUT px before upload.
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const OUTPUT_TYPE = "image/jpeg";
const OUTPUT_QUALITY = 0.9;

/**
 * `self` — the member manages their own photo (profile page, MP3).
 * `admin` — an admin manages a member's photo on their behalf (member-detail
 * page, MP4): copy is third-person and a consent note is shown.
 */
export type MemberPhotoEditorMode = "self" | "admin";

interface MemberPhotoEditorProps {
  /** The member the photo belongs to; keys the scoped serving/upload endpoint. */
  memberId: string;
  /** Display name for the placeholder initials and image alt text. */
  memberName: string;
  initialHasPhoto: boolean;
  initialPhotoVersion: string | null;
  /**
   * Whether the viewer may mutate the photo. Tri-state to match the admin
   * membership-edit gate (#2065): only `true` enables the controls; `false` or
   * `undefined` (session still resolving) renders a disabled, read-only view.
   * The MP2 endpoint independently enforces the same permission server-side.
   */
  canEdit?: boolean;
  mode?: MemberPhotoEditorMode;
}

interface LoadedSource {
  readonly image: HTMLImageElement;
  readonly natural: Size;
  readonly objectUrl: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Shared member-photo control (epic #171). Upload with an in-browser circular
 * zoom/crop guide (owner decision 7), replace, and remove — all via the
 * member-scoped MP2 endpoints. The crop is downscaled to a square OUTPUT px
 * canvas client-side; the server re-encodes, so the UI never assumes final
 * dimensions. Display crops to a circle via CSS; the stored image is the square
 * bounding box of the guide. Used self-service on the profile page (MP3) and by
 * admins on the member-detail page (MP4).
 */
export function MemberPhotoEditor({
  memberId,
  memberName,
  initialHasPhoto,
  initialPhotoVersion,
  // No default: an omitted or `undefined` value must fail closed (read-only),
  // so the admin membership-edit tri-state can't briefly grant edit while the
  // session resolves. `editable` below requires an explicit `true`.
  canEdit,
  mode = "self",
}: MemberPhotoEditorProps) {
  const router = useRouter();
  const zoomInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Callback ref (state, not useRef): the canvas lives inside the Radix Dialog,
  // which mounts its content via an open animation, so the element appears a
  // tick after `source` is set. Tracking it in state re-runs the draw effect the
  // moment the canvas is actually in the DOM — otherwise the first frame draws
  // to a not-yet-mounted canvas and the preview stays blank until the next
  // dependency change (e.g. the zoom slider).
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });
  // Object URLs created for a decode that has not yet been adopted into
  // `source` state. If the component unmounts mid-decode the load handlers never
  // run, so state alone would leak the URL — we revoke anything still pending on
  // unmount.
  const pendingObjectUrlsRef = useRef<Set<string>>(new Set());

  const [hasPhoto, setHasPhoto] = useState(initialHasPhoto);
  const [version, setVersion] = useState<string | null>(initialPhotoVersion);
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const editable = canEdit === true;
  const isAdmin = mode === "admin";
  const baseScale = source ? coverBaseScale(source.natural, VIEWPORT) : 1;
  const scale = baseScale * zoom;
  const dialogOpen = source !== null;

  // Revoke the object URL of the source being replaced. This cleanup runs both
  // when `source` changes (revoking the previous value) and on unmount, so the
  // revoke is an effect side effect rather than living inside a setState updater.
  useEffect(() => {
    const url = source?.objectUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);

  // Safety net: revoke any object URL created for a decode that never reached
  // state (e.g. the component unmounted while the image was still decoding).
  useEffect(() => {
    const pending = pendingObjectUrlsRef.current;
    return () => {
      for (const url of pending) URL.revokeObjectURL(url);
      pending.clear();
    };
  }, []);

  // Redraw the preview whenever the framing changes OR the canvas mounts.
  useEffect(() => {
    if (!source || !canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
    ctx.drawImage(
      source.image,
      offset.x,
      offset.y,
      source.natural.width * scale,
      source.natural.height * scale,
    );
  }, [canvasEl, source, offset, scale]);

  function openFilePicker() {
    if (!editable) return;
    fileInputRef.current?.click();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later.
    event.target.value = "";
    if (!file || !editable) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Please choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast.error("That image is too large. Please choose one under 25MB.");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    // Track the URL until it is either adopted into `source` state (whose effect
    // then owns its revocation) or revoked on failure below.
    pendingObjectUrlsRef.current.add(objectUrl);
    const image = new Image();
    image.onload = () => {
      const natural = { width: image.naturalWidth, height: image.naturalHeight };
      if (natural.width < 1 || natural.height < 1) {
        pendingObjectUrlsRef.current.delete(objectUrl);
        URL.revokeObjectURL(objectUrl);
        toast.error("That image could not be read.");
        return;
      }
      const nextBase = coverBaseScale(natural, VIEWPORT);
      // The source-revoke effect releases the previous source's URL; the revoke
      // stays out of the state updater (no side effects in a reducer).
      pendingObjectUrlsRef.current.delete(objectUrl);
      setSource({ image, natural, objectUrl });
      setZoom(MIN_ZOOM);
      // Centre the image within the covered viewport.
      setOffset(clampOffset({ x: 0, y: 0 }, natural, VIEWPORT, nextBase));
    };
    image.onerror = () => {
      pendingObjectUrlsRef.current.delete(objectUrl);
      URL.revokeObjectURL(objectUrl);
      toast.error("That image could not be read.");
    };
    image.src = objectUrl;
  }

  function closeDialog() {
    // The source-revoke effect releases the URL when `source` becomes null.
    setSource(null);
  }

  function handleZoomChange(nextZoom: number) {
    if (!source) return;
    const nextScale = baseScale * nextZoom;
    setZoom(nextZoom);
    setOffset((current) =>
      clampOffset(current, source.natural, VIEWPORT, nextScale),
    );
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!source) return;
    dragRef.current = {
      active: true,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!source || !dragRef.current.active) return;
    const dx = event.clientX - dragRef.current.lastX;
    const dy = event.clientY - dragRef.current.lastY;
    dragRef.current.lastX = event.clientX;
    dragRef.current.lastY = event.clientY;
    setOffset((current) =>
      clampOffset(
        { x: current.x + dx, y: current.y + dy },
        source.natural,
        VIEWPORT,
        scale,
      ),
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // Keyboard affordance for panning (and, for parity with the zoom slider,
  // +/- to zoom) so the cropper is operable without a pointer. Arrow keys nudge
  // the same `offset` state the pointer drag mutates, clamped identically.
  function handleCanvasKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!source) return;
    const step = event.shiftKey ? 32 : 8;
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case "ArrowLeft":
        dx = -step;
        break;
      case "ArrowRight":
        dx = step;
        break;
      case "ArrowUp":
        dy = -step;
        break;
      case "ArrowDown":
        dy = step;
        break;
      case "+":
      case "=":
        event.preventDefault();
        handleZoomChange(Math.min(MAX_ZOOM, zoom + 0.25));
        return;
      case "-":
      case "_":
        event.preventDefault();
        handleZoomChange(Math.max(MIN_ZOOM, zoom - 0.25));
        return;
      default:
        return;
    }
    event.preventDefault();
    setOffset((current) =>
      clampOffset(
        { x: current.x + dx, y: current.y + dy },
        source.natural,
        VIEWPORT,
        scale,
      ),
    );
  }

  async function handleSave() {
    if (!source || !editable) return;
    setSubmitting(true);
    try {
      const rect = computeSourceRect(source.natural, VIEWPORT, scale, offset);
      const out = document.createElement("canvas");
      out.width = OUTPUT;
      out.height = OUTPUT;
      const octx = out.getContext("2d");
      if (!octx) {
        toast.error("Your browser could not process the image.");
        return;
      }
      octx.drawImage(
        source.image,
        rect.sx,
        rect.sy,
        rect.sWidth,
        rect.sHeight,
        0,
        0,
        OUTPUT,
        OUTPUT,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, OUTPUT_TYPE, OUTPUT_QUALITY),
      );
      if (!blob) {
        toast.error("Your browser could not process the image.");
        return;
      }

      const formData = new FormData();
      formData.append("file", blob, "photo.jpg");
      const res = await fetch(memberPhotoServingUrl(memberId), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as {
        updatedAt?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "The photo could not be saved.");
        return;
      }
      setHasPhoto(true);
      setVersion(data.updatedAt ?? new Date().toISOString());
      closeDialog();
      toast.success("Profile photo updated.");
      router.refresh();
    } catch {
      toast.error("The photo could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    if (!editable) return;
    setRemoving(true);
    try {
      const res = await fetch(memberPhotoServingUrl(memberId), {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error || "The photo could not be removed.");
        return;
      }
      setHasPhoto(false);
      setVersion(null);
      setShowRemoveConfirm(false);
      toast.success("Profile photo removed.");
      router.refresh();
    } catch {
      toast.error("The photo could not be removed.");
    } finally {
      setRemoving(false);
    }
  }

  const currentPhotoUrl = hasPhoto
    ? memberPhotoServingUrl(memberId, version)
    : null;

  const visibilityHint = isAdmin
    ? "Shown to the member and, if they are on the committee, on the public committee page. JPEG, PNG or WebP."
    : "Your photo is shown to you here and, if you are on the committee, on the public committee page. JPEG, PNG or WebP.";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div
          className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-lg font-semibold text-muted-foreground"
          aria-hidden={currentPhotoUrl ? undefined : true}
        >
          {currentPhotoUrl ? (
            // Plain <img>: the source is an authenticated, no-store endpoint, so
            // it must bypass the image optimiser.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentPhotoUrl}
              alt={`${memberName}'s profile photo`}
              width={80}
              height={80}
              className="h-full w-full object-cover"
            />
          ) : (
            <span>{initials(memberName)}</span>
          )}
        </div>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={openFilePicker} variant="outline">
              {hasPhoto ? (
                <Camera className="h-4 w-4" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              {hasPhoto ? "Change photo" : "Add photo"}
            </Button>
            {hasPhoto ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowRemoveConfirm(true)}
                disabled={removing}
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </Button>
            ) : null}
          </div>
        ) : canEdit === false ? (
          // Definitive denial only. While `canEdit` is still `undefined`
          // (permission resolving) we render the avatar with no controls and no
          // message, matching the house anti-flash contract — an edit-capable
          // admin must never briefly see a "you cannot change this" message.
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "You have view-only access to membership, so you cannot change this photo."
              : "You do not have permission to change this photo."}
          </p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{visibilityHint}</p>
      {editable && isAdmin ? (
        <p className="text-xs text-muted-foreground">
          You are managing this photo on the member&apos;s behalf; make sure they
          have agreed to it being used. Every change is recorded in the audit
          log.
        </p>
      ) : null}

      {editable ? (
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          onChange={handleFileChange}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : null}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isAdmin ? `Frame ${memberName}'s photo` : "Frame your photo"}
            </DialogTitle>
            <DialogDescription>
              Drag or use the arrow keys to reposition; use the zoom slider or
              the plus and minus keys to zoom. The area inside the frame is saved
              as your photo; some pages show it as a circle and others as a
              square, so the corners may be visible too.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            <div
              className="relative touch-none"
              style={{ width: VIEWPORT, height: VIEWPORT }}
            >
              <canvas
                ref={setCanvasEl}
                width={VIEWPORT}
                height={VIEWPORT}
                tabIndex={0}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onKeyDown={handleCanvasKeyDown}
                className="cursor-move rounded-md bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                role="img"
                aria-label="Photo crop preview. Drag or use the arrow keys to reposition; use the zoom slider or the plus and minus keys to zoom."
              />
              {/* Circular framing guide: darkens the area outside the circle. */}
              <div
                className="pointer-events-none absolute inset-0 rounded-full"
                style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/70"
                aria-hidden="true"
              />
            </div>
            <div className="w-full space-y-1">
              <Label htmlFor={zoomInputId}>Zoom</Label>
              <input
                id={zoomInputId}
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(event) =>
                  handleZoomChange(Number(event.target.value))
                }
                className="w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {submitting ? "Saving..." : "Save photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showRemoveConfirm}
        onOpenChange={(open) => {
          if (!open) setShowRemoveConfirm(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isAdmin ? "Remove this photo?" : "Remove your photo?"}
            </DialogTitle>
            <DialogDescription>
              {isAdmin
                ? "The member's profile photo will be deleted. If they are on the committee, the committee page will fall back to no photo."
                : "Your profile photo will be deleted. If you are on the committee, the committee page will fall back to no photo."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowRemoveConfirm(false)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {removing ? "Removing..." : "Remove photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
