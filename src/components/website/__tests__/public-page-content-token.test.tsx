import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MembershipTypesToken } from "@/components/website/public-page-content-token";

describe("public PageContent token rendering", () => {
  it("escapes hostile persisted display strings", () => {
    const html = renderToStaticMarkup(<MembershipTypesToken items={[{
      name: '<script>alert("name")</script>',
      description: '<img src=x onerror="alert(1)">',
      annualFee: { amountCents: 1000, label: "$10.00" },
      billingLabel: "Per member; no proration",
    }]} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
});
