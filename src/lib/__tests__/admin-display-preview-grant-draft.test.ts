import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  builderLayout,
  builderSlotContent,
  type BuilderModel,
} from "@/lib/lodge-display/builder-model";

// Draft live-preview mint (ADR-004 §7, §9). The preview-grant endpoint accepts an
// UNSAVED builder draft: it validates through the exact save contract, renders it,
// stores the rendered payload keyed by a nonce, and mints a draft-handle grant. A
// broken draft returns structured errors and NO grant; a valid draft's payload is
// readable by nonce and the grant authorises only the preview.

// The route pulls in server-only (buildLayoutRender / save contract / store); stub.
vi.mock("server-only", () => ({}));

const { mockPrisma, mockRequireAdmin, mockResolveOptionalLodge, mockBuildDisplayState } =
  vi.hoisted(() => ({
    mockPrisma: { lodge: { findUnique: vi.fn() }, displayTemplate: { findUnique: vi.fn() } },
    mockRequireAdmin: vi.fn(),
    mockResolveOptionalLodge: vi.fn(),
    mockBuildDisplayState: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: (...a: unknown[]) => mockResolveOptionalLodge(...a),
}));
vi.mock("@/lib/lodge-display-state", () => ({
  buildDisplayState: (...a: unknown[]) => mockBuildDisplayState(...a),
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: vi.fn(async () => ({ css: ":root{--brand-gold:#c9a}" })),
}));

function state(): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [],
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
  } as unknown as DisplayState;
}

/** A valid builder draft (a single arrivals-board zone) via the real generators. */
function validDraft() {
  const model: BuilderModel = {
    skeleton: "columns",
    zones: [
      {
        key: "zone-1",
        description: "Board",
        kind: "static",
        content: { type: "module", module: "arrivals-board", options: { days: 3 } },
      },
    ],
  };
  const layout = builderLayout(model);
  return {
    bodyHtml: layout.bodyHtml,
    defaultCss: layout.defaultCss,
    areas: layout.areas,
    slotContent: builderSlotContent(model),
    cssOverrides: "",
    footerHtml: "",
  };
}

async function jsonRequest(body: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/admin/display/preview-grant", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-display-secret";
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mockResolveOptionalLodge.mockResolvedValue("lodge-b");
  mockPrisma.lodge.findUnique.mockResolvedValue({ id: "lodge-b", name: "Ruapehu Lodge" });
  mockBuildDisplayState.mockResolvedValue(state());
  const { __resetDraftPreviewStore } = await import(
    "@/lib/lodge-display/draft-preview-store"
  );
  __resetDraftPreviewStore();
});

describe("POST /api/admin/display/preview-grant — draft preview (ADR-004 §7)", () => {
  it("requires an admin session before touching a draft", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const res = await POST(await jsonRequest({ draft: validDraft() }));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("mints a draft-handle grant and stores a readable rendered payload", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const { decodePreviewGrant } = await import("@/lib/lodge-display-auth");
    const { getDraftPreview } = await import("@/lib/lodge-display/draft-preview-store");

    const res = await POST(await jsonRequest({ draft: validDraft(), previewLodge: "lodge-b" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; lodgeName: string };
    expect(body.lodgeName).toBe("Ruapehu Lodge");

    const grant = decodePreviewGrant(body.token);
    expect(grant).not.toBeNull();
    // The grant names a draft nonce, not a template — it authorises the preview
    // render and nothing else (no templateId, single-purpose).
    expect(grant!.templateId).toBeNull();
    expect(typeof grant!.draftNonce).toBe("string");
    expect(grant!.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);

    // The rendered payload is readable by nonce (what the state route serves).
    const rendered = getDraftPreview(grant!.draftNonce!);
    expect(rendered).not.toBeNull();
    expect(rendered!.bodyHtml).toContain('data-display-area="zone-1"');
  });

  it("returns structured errors and mints NO grant for a broken draft", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    // A signed body with a placeholder that has no matching area → the save
    // contract refuses it (bodyHtml/areas disagree).
    const brokenDraft = {
      bodyHtml: '<div class="dlb-root dlb-cols dlb-cols-1">{{area:ghost}}</div>',
      defaultCss: "",
      areas: [],
      slotContent: {},
      cssOverrides: "",
      footerHtml: "",
    };
    const res = await POST(await jsonRequest({ draft: brokenDraft }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: { message: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    // No draft was rendered/stored (validation failed before the render step).
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("an expired/unknown nonce yields nothing from the store", async () => {
    const { getDraftPreview } = await import("@/lib/lodge-display/draft-preview-store");
    expect(getDraftPreview("never-minted")).toBeNull();
  });
});
