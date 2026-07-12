import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("database theme app-shell contract", () => {
  it.each(["src/app/(authenticated)/layout.tsx", "src/app/(admin)/layout.tsx"])(
    "injects the sanitized ClubTheme CSS in %s",
    (path) => {
      const layout = readRepoFile(path);

      expect(layout).toContain("getWebsiteThemeRenderState()");
      expect(layout).toContain('data-site-style="club-theme"');
      expect(layout).toContain(
        "dangerouslySetInnerHTML={{ __html: theme.appCss }}",
      );
    },
  );

  it("maps app presentation tokens to brand variables without remapping semantic status", () => {
    const globals = readRepoFile("src/app/globals.css");
    const start = globals.indexOf(".app-theme-scope {");
    const end = globals.indexOf("/* App headings pick up", start);
    const appThemeRules = globals.slice(start, end);
    const darkStart = appThemeRules.indexOf(".dark .app-theme-scope {");
    const darkRules = appThemeRules.slice(darkStart);

    expect(appThemeRules).toContain("--primary: var(--brand-gold)");
    expect(appThemeRules).toContain("--background: var(--brand-snow)");
    expect(appThemeRules).toContain("--background: var(--brand-deep)");
    expect(appThemeRules).toContain("--muted-foreground: var(--brand-deep)");
    expect(appThemeRules).toContain("--muted-foreground: var(--brand-snow)");
    expect(appThemeRules).toContain("var(--brand-charcoal) 58%");
    expect(appThemeRules).toContain("--app-accent-text: var(--brand-charcoal)");
    expect(appThemeRules).toContain("--ring: var(--brand-charcoal)");
    expect(appThemeRules).not.toContain("color-mix(in srgb, white");
    expect(appThemeRules).toMatch(
      /--card:\s*color-mix\(\s*in srgb,\s*var\(--brand-mist\) 22%,\s*var\(--brand-snow\)/,
    );
    expect(appThemeRules).toMatch(
      /--popover:\s*color-mix\(\s*in srgb,\s*var\(--brand-mist\) 22%,\s*var\(--brand-snow\)/,
    );
    expect(appThemeRules).toMatch(
      /--sidebar-accent:\s*color-mix\(\s*in srgb,\s*var\(--brand-charcoal\) 80%,\s*var\(--brand-deep\)/,
    );
    expect(appThemeRules).toContain('[class~="hover:text-primary"]:hover');
    expect(appThemeRules).toContain(
      '.group:hover [class~="group-hover:text-primary"]',
    );
    expect(appThemeRules.match(/:not\(\.website-theme \*\)/g)).toHaveLength(4);
    expect(darkRules).toMatch(
      /--accent:\s*color-mix\(\s*in srgb,\s*var\(--brand-charcoal\) 58%,\s*var\(--brand-deep\)/,
    );
    expect(darkRules).toMatch(
      /--sidebar-accent:\s*color-mix\(\s*in srgb,\s*var\(--brand-charcoal\) 44%,\s*var\(--brand-deep\)/,
    );
    expect(darkRules).not.toMatch(
      /--(?:sidebar-)?accent:\s*color-mix\([^;]*var\(--brand-gold\)/,
    );
    expect(appThemeRules).toContain("--font-website-body");
    expect(appThemeRules).toContain("--font-website-heading");
    expect(appThemeRules).not.toMatch(
      /--(?:success|warning|info|danger)(?:-|:)/,
    );
  });
});
