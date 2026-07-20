import "server-only";

import { randomBytes } from "crypto";
import type { LayoutRenderPayload } from "./layout-registry";

// Ephemeral draft-preview store (ADR-004 §7). The visual builder can preview an
// UNSAVED draft: the admin-only preview-grant mint validates the draft, renders
// it with `buildLayoutRender`, and holds the resulting (already sanitised +
// privacy-reduced) `LayoutRenderPayload` here, keyed by a nonce embedded in the
// signed preview grant. The sandboxed /display frame then reads it through the
// state route exactly as it reads a stored template preview — no DB row, no
// schema change, no orphan `DisplayTemplate`.
//
// IN-MEMORY, SINGLE-INSTANCE (owner-decided infra point, issue #2048): the admin
// preview surface runs on a single instance, so a process-local Map is
// sufficient; a multi-instance deployment would need a shared store, but the
// draft preview is a short-lived admin affordance, not a serving-path dependency
// (real walls bind to SAVED templates). Entries expire with the 5-minute grant
// TTL and are swept lazily on every access; a hard cap bounds memory against a
// burst of re-mints. Server-only: it holds rendered payloads and must never
// enter a client bundle.

interface StoredDraftPreview {
  payload: LayoutRenderPayload;
  /** Unix ms; an entry at/after this is expired and never returned. */
  expiresAt: number;
}

// Matches PREVIEW_GRANT_TTL_SECONDS — the draft lives exactly as long as the
// grant that names it, so a nonce can never outlive its capability.
export const DRAFT_PREVIEW_TTL_SECONDS = 5 * 60;

// A defensive ceiling so repeated re-mints (each Reload preview click) cannot
// grow the map without bound between sweeps. Far above any real concurrent
// admin-preview count; when exceeded the oldest entries are dropped first.
const MAX_DRAFT_ENTRIES = 200;

const store = new Map<string, StoredDraftPreview>();

/** Drop every expired entry (lazy GC — there is no timer). */
function sweep(now: number): void {
  for (const [nonce, entry] of store) {
    if (entry.expiresAt <= now) store.delete(nonce);
  }
}

/** Enforce the size ceiling by evicting the oldest insertions (Map preserves
 * insertion order) after a sweep has already removed the expired ones. */
function enforceCap(): void {
  while (store.size > MAX_DRAFT_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Store a rendered draft preview and return the nonce the grant will carry. The
 * nonce is a 144-bit random token (opaque, unguessable); it is the ONLY handle
 * to the payload and is meaningful solely inside a validly-signed grant.
 */
export function storeDraftPreview(
  payload: LayoutRenderPayload,
  ttlSeconds: number = DRAFT_PREVIEW_TTL_SECONDS
): string {
  const now = Date.now();
  sweep(now);
  const nonce = randomBytes(18).toString("base64url");
  store.set(nonce, { payload, expiresAt: now + ttlSeconds * 1000 });
  enforceCap();
  return nonce;
}

/**
 * Read a stored draft preview by nonce. Returns null when the nonce is unknown
 * or expired. NOT single-use — the preview frame polls the state route
 * repeatedly for the same grant, so the payload stays readable until its TTL.
 */
export function getDraftPreview(nonce: string): LayoutRenderPayload | null {
  const now = Date.now();
  sweep(now);
  const entry = store.get(nonce);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.payload;
}

/** Test-only: clear the store between cases. */
export function __resetDraftPreviewStore(): void {
  store.clear();
}
