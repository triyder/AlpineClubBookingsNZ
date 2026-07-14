import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mutable identity state so URL-token tests can vary the configured values;
// getters make the mocked module read the current state on every access.
const identityState = vi.hoisted(() => ({
  facebookUrl: undefined as string | undefined,
  publicUrl: "https://club.example.org",
}));

vi.mock("@/config/club-identity", () => ({
  CLUB_NAME: "Club <Name>",
  get CLUB_FACEBOOK_URL() {
    return identityState.facebookUrl;
  },
  get CLUB_PUBLIC_URL() {
    return identityState.publicUrl;
  },
}));
vi.mock("@/config/operational", () => ({ APP_CURRENCY: "NZD & GST" }));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: vi.fn(async () => 42),
  getLodgeCapacity: vi.fn(async (lodgeId: string) =>
    lodgeId === "lodge-2" ? 18 : 0,
  ),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
        where.slug === "river-lodge" ? { id: "lodge-2" } : null,
      ),
    },
  },
}));
vi.mock("@/lib/public-page-content-tokens", () => ({
  loadPublicMembershipTypes: vi.fn(async () => [{ name: "Public member" }]),
  loadPublicEntranceFees: vi.fn(async () => [{ category: "Adult" }]),
  loadPublicHutFees: vi.fn(async (slug?: string) => [{ slug: slug ?? "all" }]),
  loadPublicBookingPolicy: vi.fn(async (slug?: string) => ({ lodge: slug ?? null })),
  loadPublicCancellationPolicy: vi.fn(async (slug?: string) => ({ lodge: slug ?? null })),
}));
// sanitizePageContentHtml is pure but its module imports the prisma client.

import { buildEmbeddedBody, resolveTextTokens } from "../page-content-embeds";
import { sanitizePageContentHtml } from "../page-content-html";
import { starterSiteContent } from "../../../prisma/starter-site-content";
import logger from "@/lib/logger";

describe("buildEmbeddedBody", () => {
  it("maps every public data token, including lodge variants, through the shared registry", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Start</p>{{membership-types}}{{entrance-fees}}{{hut-fees}}{{hut-fees:river-lodge}}{{booking-policy-summary}}{{booking-policy-summary:river-lodge}}{{cancellation-policy}}{{cancellation-policy:river-lodge}}<p>End</p>",
    );
    expect(parts.map((part) => part.type)).toEqual([
      "html", "membership-types", "entrance-fees", "hut-fees", "hut-fees",
      "booking-policy-summary", "booking-policy-summary", "cancellation-policy",
      "cancellation-policy", "html",
    ]);
    expect(parts[4]).toEqual({ type: "hut-fees", lodges: [{ slug: "river-lodge" }] });
  });

  it("preserves mixed rich HTML and repeated tokens without falling back to contact form", async () => {
    const parts = await buildEmbeddedBody("<h2>Fees</h2>{{entrance-fees}}<p>Again</p>{{entrance-fees}}");
    expect(parts.map((part) => part.type)).toEqual(["html", "entrance-fees", "html", "entrance-fees"]);
    expect(parts.some((part) => part.type === "contact-form")).toBe(false);
  });
  it("preserves inline images when no gallery token is present", async () => {
    const parts = await buildEmbeddedBody(
      '<div class="col_display_body"><p><img src="/api/images/uploaded/Lodge_Winter.jpg" width="463" height="169" /><br></p><p>Our Ski Lodge is located on Mt Ruapehu on the Whakapapa ski field, just 5 minutes from the top overnight carpark.</p></div>',
    );

    expect(parts).toEqual([
      {
        type: "html",
        value:
          '<div class="col_display_body"><p><img src="/api/images/uploaded/Lodge_Winter.jpg" width="463" height="169" /><br></p><p>Our Ski Lodge is located on Mt Ruapehu on the Whakapapa ski field, just 5 minutes from the top overnight carpark.</p></div>',
      },
    ]);
  });

  it("extracts inline images for gallery tokens", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/gallery.jpg" alt="Gallery image" width="640" height="480" />{{photo-gallery}}<p>After</p>',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-gallery",
        images: [
          {
            src: "/api/images/uploaded/gallery.jpg",
            alt: "Gallery image",
            width: 640,
            height: 480,
          },
        ],
      },
      { type: "html", value: "<p>After</p>" },
    ]);
  });

  it("extracts inline images for slideshow tokens", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/slideshow.jpg" alt="Slideshow image" width="800" height="600" />{{photo-slideshow}}',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-slideshow",
        images: [
          {
            src: "/api/images/uploaded/slideshow.jpg",
            alt: "Slideshow image",
            width: 800,
            height: 600,
          },
        ],
      },
    ]);
  });

  it("does not activate single-brace photo gallery tokens", async () => {
    const contentHtml =
      '<p>Before</p><img src="/api/images/uploaded/gallery.jpg" alt="Gallery image" width="640" height="480" />{photo-gallery}<p>After</p>';

    const parts = await buildEmbeddedBody(contentHtml);

    expect(parts).toEqual([{ type: "html", value: contentHtml }]);
  });

  it("does not activate single-brace photo slideshow tokens", async () => {
    const contentHtml =
      '<p>Before</p><img src="/api/images/uploaded/slideshow.jpg" alt="Slideshow image" width="800" height="600" />{photo-slideshow}<p>After</p>';

    const parts = await buildEmbeddedBody(contentHtml);

    expect(parts).toEqual([{ type: "html", value: contentHtml }]);
  });

  it("keeps legacy single-brace non-photo tokens working", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Before</p>{contact-form}<p>After</p>",
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      { type: "contact-form" },
      { type: "html", value: "<p>After</p>" },
    ]);
  });

  it("resolves live text tokens as escaped html", async () => {
    const parts = await buildEmbeddedBody(
      "<p>{{club-name}} sleeps {{lodge-capacity}} and charges {{currency}}.</p>",
    );

    expect(parts).toEqual([
      {
        type: "html",
        value: "<p>Club &lt;Name&gt; sleeps 42 and charges NZD &amp; GST.</p>",
      },
    ]);
  });

  it("resolves {{lodge-capacity:slug}} against the named lodge", async () => {
    const parts = await buildEmbeddedBody(
      "<p>River sleeps {{lodge-capacity:river-lodge}}; main lodge {{lodge-capacity}}.</p>",
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>River sleeps 18; main lodge 42.</p>" },
    ]);
  });

  it("falls back to the default lodge for an unknown slug", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Sleeps {{lodge-capacity:no-such-lodge}}.</p>",
    );

    expect(parts).toEqual([{ type: "html", value: "<p>Sleeps 42.</p>" }]);
  });
});

describe("resolveTextTokens URL scheme validation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    identityState.facebookUrl = undefined;
    identityState.publicUrl = "https://club.example.org";
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("passes an http(s) facebook URL through unchanged", async () => {
    identityState.facebookUrl = "https://www.facebook.com/exampleclub";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
    );

    expect(resolved).toBe(
      '<a href="https://www.facebook.com/exampleclub">Facebook</a>',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("passes a mailto value through unchanged", async () => {
    identityState.facebookUrl = "mailto:social@example.org";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Contact</a>',
    );

    expect(resolved).toBe('<a href="mailto:social@example.org">Contact</a>');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the public URL when no facebook URL is configured", async () => {
    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
    );

    expect(resolved).toBe(
      '<a href="https://club.example.org">Facebook</a>',
    );
  });

  it("replaces a javascript: facebook URL with the public URL and warns once", async () => {
    identityState.facebookUrl = "javascript:alert(document.cookie)";

    const first = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
    );
    const second = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
    );

    expect(first).toBe('<a href="https://club.example.org">Facebook</a>');
    expect(second).toBe(first);
    expect(first).not.toContain("javascript:");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to # when the public URL is also unsafe", async () => {
    identityState.facebookUrl = "javascript:void(0)";
    identityState.publicUrl = "javascript:bad()";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
    );

    expect(resolved).toBe('<a href="#">Facebook</a>');
    expect(resolved).not.toContain("javascript:");
  });

  it("never renders a javascript: href through the starter footer path", async () => {
    identityState.facebookUrl = "javascript:alert(1)";
    const affiliations = starterSiteContent.find(
      (section) => section.key === "FOOTER_AFFILIATIONS",
    );
    expect(affiliations).toBeDefined();

    // Mirrors renderFooterSection in site-content.ts: sanitise the stored
    // HTML first, then resolve text tokens on the sanitised output.
    const sanitised = sanitizePageContentHtml(affiliations!.contentHtml);
    const resolved = await resolveTextTokens(sanitised);

    expect(resolved).not.toContain("javascript:");
    expect(resolved).toContain('href="https://club.example.org"');
  });
});
