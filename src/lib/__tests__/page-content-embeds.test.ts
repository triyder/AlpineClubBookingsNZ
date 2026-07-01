import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config/club-identity", () => ({ CLUB_NAME: "Club <Name>" }));
vi.mock("@/config/operational", () => ({ APP_CURRENCY: "NZD & GST" }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn(async () => 42),
}));

import { buildEmbeddedBody } from "../page-content-embeds";

describe("buildEmbeddedBody", () => {
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
});
