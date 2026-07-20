import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { SiteBanners } from "@/components/site-banners";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { getCurrentSiteBanners } from "@/lib/site-banners";

function resolvePageSlug(requestHeaders: Headers) {
  return requestHeaders.get("x-page-slug") ?? "home";
}

export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, theme, requestHeaders, siteBanners, modules, clubIdentity] =
    await Promise.all([
      auth(),
      getWebsiteThemeRenderState(),
      headers(),
      getCurrentSiteBanners(),
      loadEffectiveModuleFlags(),
      getCachedClubIdentity(),
    ]);
  const pageSlug = resolvePageSlug(requestHeaders);
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;
  const themeStyle = (
    <style
      dangerouslySetInnerHTML={{ __html: theme.css }}
      data-site-style="club-theme"
    />
  );

  if (!theme.isComplete) {
    // DB-first contact address (C6 #1985): resolved only when the pre-setup
    // fallback screen actually renders, so the hot website layout adds no extra
    // query on the normal path. Reads EmailMessageSetting.contactEmail with the
    // config default as fallback — never a synchronous club.json read.
    const { contactEmail } = await loadEmailMessageSettings();
    return (
      <div
        className={`${clubThemeFontVariableClassName} website-theme min-h-screen bg-background text-foreground`}
      >
        {themeStyle}
        <main className="flex min-h-screen items-center justify-center px-4 py-16">
          <section className="mx-auto max-w-2xl text-center">
            <p className="website-eyebrow mb-4">Site setup in progress</p>
            <h1 className="font-heading text-4xl font-bold text-brand-charcoal sm:text-5xl">
              {clubIdentity.name} is getting ready.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-brand-deep/80 sm:text-lg">
              The public website will open after an administrator completes the
              site style setup.
            </p>
            <p className="mt-6 text-sm text-brand-ridge">
              Contact{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                {contactEmail}
              </a>
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`${clubThemeFontVariableClassName} website-theme min-h-screen flex flex-col bg-background text-foreground`}
    >
      {themeStyle}
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
        href="#main-content"
      >
        Skip to main content
      </a>
      <SiteBanners banners={siteBanners} />
      <WebsiteHeader
        isAuthenticated={!!session?.user}
        logoDataUrl={theme.logoDataUrl}
      />
      <main className="flex-1" id="main-content">{children}</main>
      <WebsiteFooter logoDataUrl={theme.logoDataUrl} pageSlug={pageSlug} />
      <AnalyticsConsent
        enabled={modules.analytics}
        measurementId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}
        nonce={nonce}
      />
    </div>
  );
}
