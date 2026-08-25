import { describe, expect, it } from "vitest";

import {
  emailBodyHtmlToText,
  plainTextToEmailBodyHtml,
  renderEmailBodyHtml,
  renderHtmlTemplateString,
  sanitiseEmailBodyHtml,
} from "@/lib/email-body-html";

/**
 * Rich email bodies (fork #38). The policy is the control: everything an
 * admin submits reduces to the allowlist, token VALUES can never inject
 * markup, and the derived text keeps every text-based rule meaningful.
 */

describe("sanitiseEmailBodyHtml", () => {
  it("keeps the editor vocabulary (styles normalised by the sanitiser)", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<p style="text-align: center;"><b>Bold</b> <i>italic</i> <u>underlined</u></p><ul><li>one</li><li>two</li></ul>',
      ),
    ).toBe(
      '<p style="text-align:center"><b>Bold</b> <i>italic</i> <u>underlined</u></p><ul><li>one</li><li>two</li></ul>',
    );
  });

  it("strips scripts, handlers, images, links and colours to their text", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<p onclick="x()"><script>alert(1)</script><a href="https://evil.example">click</a> <span style="color: red">red</span><img src=x onerror=alert(1)></p>',
      ),
    ).toBe("<p>click <span>red</span></p>");
  });

  it("drops disallowed style declarations but keeps allowed text-align", () => {
    expect(
      sanitiseEmailBodyHtml(
        '<div style="text-align: right; font-size: 60px; position: fixed;">x</div>',
      ),
    ).toBe('<div style="text-align:right">x</div>');
  });

  it("leaves {{token}} markers untouched as text", () => {
    expect(sanitiseEmailBodyHtml("<p>Hi {{firstName}}</p>")).toBe(
      "<p>Hi {{firstName}}</p>",
    );
  });
});

describe("renderHtmlTemplateString", () => {
  it("substitutes tokens with HTML-escaped values", () => {
    expect(
      renderHtmlTemplateString("<p>Hi {{firstName}}</p>", {
        firstName: 'Sam <script>alert(1)</script> & "co"',
      }),
    ).toBe("<p>Hi Sam &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;</p>");
  });

  it("keeps a multi-line pre-composed block value's line structure as <br>", () => {
    expect(
      renderHtmlTemplateString("<p>{{paymentOutcome}}</p>", {
        paymentOutcome: "Total Paid: $300.00\nPayment has been processed successfully.",
      }),
    ).toBe(
      "<p>Total Paid: $300.00<br>Payment has been processed successfully.</p>",
    );
  });

  it("renders absent and null values as nothing, like the plain path", () => {
    expect(
      renderHtmlTemplateString("<p>{{missing}}{{empty}}</p>", { empty: null }),
    ).toBe("<p></p>");
  });
});

describe("renderEmailBodyHtml", () => {
  it("stamps the mail-client spacing styles, preserving the author's alignment", () => {
    const html = renderEmailBodyHtml(
      '<p style="text-align:center">Hi</p><ul><li>one</li></ul>',
    );
    expect(html).toContain('style="margin:0 0 12px 0;line-height:1.6;text-align:center"');
    expect(html).toContain('<ul style="margin:0 0 12px 0;padding-left:22px">');
    expect(html).toContain('<li style="margin:0 0 4px 0">one</li>');
  });

  it("is a defence-in-depth pass — markup smuggled past storage still dies here", () => {
    expect(renderEmailBodyHtml('<p><img src=x onerror=alert(1)>ok</p>')).toBe(
      '<p style="margin:0 0 12px 0;line-height:1.6">ok</p>',
    );
  });
});

describe("plainTextToEmailBodyHtml", () => {
  it("upgrades blocks to paragraphs and inner newlines to <br>, escaped", () => {
    expect(
      plainTextToEmailBodyHtml("Heading\n\nLine one\nLine <two>\n\nBye"),
    ).toBe("<p>Heading</p><p>Line one<br>Line &lt;two&gt;</p><p>Bye</p>");
  });

  it("round-trips: extracting the upgrade returns the original text", () => {
    const text =
      "Booking Confirmed\n\nHi {{firstName}}, your booking is confirmed.\nCheck-in: {{checkIn}}\n\nSee you soon.";
    expect(emailBodyHtmlToText(plainTextToEmailBodyHtml(text))).toBe(text);
  });
});

describe("emailBodyHtmlToText", () => {
  it("keeps block structure as line structure, tokens intact — paragraphs are blank-line blocks", () => {
    expect(
      emailBodyHtmlToText(
        "<p>Hi <b>{{firstName}}</b></p><ul><li>one</li><li>two</li></ul><p>Bye</p>",
      ),
    ).toBe("Hi {{firstName}}\n\none\ntwo\nBye");
  });
});
