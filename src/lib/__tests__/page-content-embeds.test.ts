import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
});
