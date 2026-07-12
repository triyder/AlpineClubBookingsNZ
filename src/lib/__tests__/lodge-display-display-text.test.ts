import { describe, expect, it } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  resolveDisplayHtml,
  resolveDisplayText,
} from "@/lib/lodge-display/display-text";

// LTV-028: the HTML value-token resolver (resolveDisplayHtml) shares one closed
// grammar with the existing text resolver (resolveDisplayText) but HTML-escapes
// each injected value, and — crucially — leaves any non-display token verbatim
// so a wall can never surface a site-catalogue token (ADR-003 §4).

function state(overrides: Partial<DisplayState> = {}): DisplayState {
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
    config: { "wifi-code": "alpine1234" },
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

describe("resolveDisplayHtml — value tokens inside authored html", () => {
  it("resolves config/lodge-name/display-date the same as the text variant", () => {
    const s = state();
    expect(resolveDisplayHtml("<p>Wi-Fi {{config:wifi-code}}</p>", s)).toBe(
      "<p>Wi-Fi alpine1234</p>"
    );
    expect(resolveDisplayHtml("<h1>{{lodge-name}}</h1>", s)).toBe(
      "<h1>Silverpeak Lodge</h1>"
    );
    expect(resolveDisplayHtml("<time>{{display-date}}</time>", s)).toMatch(
      /Monday.*13.*April/
    );
  });

  it("HTML-escapes an injected config value so it can never inject markup", () => {
    const s = state({ config: { note: "<img src=x onerror=alert(1)>" } });
    const html = resolveDisplayHtml("<p>{{config:note}}</p>", s);
    // The value is rendered as escaped text, not a live element.
    expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(html).not.toContain("<img");
  });

  it("escapes a <script> config value to inert text", () => {
    const s = state({ config: { note: "<script>steal()</script>" } });
    expect(resolveDisplayHtml("{{config:note}}", s)).toBe(
      "&lt;script&gt;steal()&lt;/script&gt;"
    );
  });

  it("neutralises braces in a value so it cannot form a second token", () => {
    // A config value that itself looks like a token must stay inert text — its
    // braces are escaped so no later splitter (config/area/module) acts on it.
    const s = state({ config: { note: "{{module:chores-board}}" } });
    const html = resolveDisplayHtml("<p>{{config:note}}</p>", s);
    expect(html).toBe("<p>&#123;&#123;module:chores-board&#125;&#125;</p>");
    expect(html).not.toContain("{{module:");
  });

  it("keeps the VISIBLE unset marker for an unknown config key", () => {
    expect(resolveDisplayHtml("<p>{{config:door-pin}}</p>", state())).toBe(
      "<p>⟨config:door-pin?⟩</p>"
    );
  });

  it("leaves a site-catalogue token VERBATIM (token-scope boundary, ADR-003 §4)", () => {
    // {{club-name}} is a real site-catalogue token (src/lib/token-catalogue.ts)
    // and the club name IS in the payload — but it is NOT in the display token
    // set, so it must pass through unresolved rather than surface site data.
    const s = state();
    expect(resolveDisplayHtml("<p>{{club-name}}</p>", s)).toBe("<p>{{club-name}}</p>");
    expect(resolveDisplayHtml("<p>{{lodge-capacity}}</p>", s)).toBe(
      "<p>{{lodge-capacity}}</p>"
    );
    expect(resolveDisplayHtml("<p>{{facebook-url}}</p>", s)).toBe(
      "<p>{{facebook-url}}</p>"
    );
  });

  it("leaves a {{module:…}} embed token untouched for the client splitter", () => {
    const s = state();
    expect(resolveDisplayHtml("<div>{{module:arrivals-board}}</div>", s)).toBe(
      "<div>{{module:arrivals-board}}</div>"
    );
  });
});

describe("resolveDisplayText — unchanged text-path behaviour", () => {
  it("still returns raw (unescaped) text for React text nodes", () => {
    const s = state({ config: { note: "<img onerror=x>" } });
    // The text variant does NOT escape — React escapes at the text node.
    expect(resolveDisplayText("{{config:note}}", s)).toBe("<img onerror=x>");
    expect(resolveDisplayText("{{club-name}}", s)).toBe("{{club-name}}");
  });
});
