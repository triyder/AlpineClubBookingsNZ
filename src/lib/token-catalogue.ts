// Client-safe catalogue of the {{token}} placeholders supported by admin
// rich-text (HTML) content. This module is the single source of truth for
// token names, help copy, and syntax rules: the matching regexes in
// src/lib/page-content-embeds.ts and the admin token-help UI are both derived
// from it. Deliberately no "server-only" import and no server dependencies —
// client components import this directly.

/** Editor surfaces a token can be used in. */
export type TokenContextId =
  | "page-content-body"
  | "lodge-instructions"
  | "site-footer";

export type HtmlTokenDefinition = {
  /** Canonical lower-case token name, without braces. */
  token: string;
  /**
   * "embed" tokens are replaced with a structured component when the page
   * body renders; "text" tokens are replaced inline with an escaped string.
   */
  kind: "embed" | "text";
  /** Help copy shown to admins. */
  description: string;
  /** Canonical usage example, braces included. */
  example: string;
  /** Extra walkthrough help (for example the skifield data-hash steps). */
  notes?: string;
  /** True when the token meaningfully accepts a `{{token:parameter}}` value. */
  allowsParameter?: boolean;
  parameterExample?: string;
  /**
   * True when the legacy single-brace form ({token}) is still accepted by the
   * embed matcher. Photo tokens and text tokens require double braces.
   */
  allowsLegacySingleBrace: boolean;
  contexts: TokenContextId[];
};

// test seam
export const HTML_TOKEN_CATALOGUE: readonly HtmlTokenDefinition[] = [
  {
    token: "committee-members-cards",
    kind: "embed",
    description:
      "This will display cards in a grid with a committee member in each one.",
    example: "{{committee-members-cards}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "member-application-form",
    kind: "embed",
    description: "This will display the Membership application form.",
    example: "{{member-application-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "contact-form",
    kind: "embed",
    description:
      "This will display a contact us form where a user can send a message " +
      "to the club or to a published contactable committee assignment.",
    example: "{{contact-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "join-apply-form",
    kind: "embed",
    description: "This will display the Membership application form.",
    example: "{{join-apply-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "skifield-conditions",
    kind: "embed",
    description:
      "This will display the Ski resort status, weather, chairlift status, " +
      "road status.",
    example: "{{skifield-conditions}}",
    notes:
      "You will need to go to https://www.snow.nz/snow-report-widget and " +
      "select the skifield you want information on. On submit you will be " +
      'shown a script. On the first line, copy the hash code within the ' +
      'quotes. e.g. data-hash="zzz". On this editor page do the following, ' +
      "while replacing zzz with your hashcode.",
    allowsParameter: true,
    parameterExample: "{{skifield-conditions:zzz}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "skifield-whakapapa",
    kind: "embed",
    description:
      "This will fetch the Whakapapa report and render a parsed curlData " +
      "JSON object.",
    example: "{{skifield-whakapapa}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "photo-gallery",
    kind: "embed",
    description:
      "This will display a PhotoSwipe gallery using the images already " +
      "inserted into the page body.",
    example: "{{photo-gallery}}",
    notes:
      "Add your images to the page body, then place the token where the " +
      "gallery should appear. You can also pass a folder path.",
    allowsParameter: true,
    parameterExample: "{{photo-gallery:/public/images/photos/One}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "photo-slideshow",
    kind: "embed",
    description:
      "This will display the same images in a slideshow-oriented PhotoSwipe " +
      "layout.",
    example: "{{photo-slideshow}}",
    notes:
      "Use the same folder-path format when you want to load all photos " +
      "from a directory.",
    allowsParameter: true,
    parameterExample: "{{photo-slideshow:/public/images/photos/One}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "club-name",
    kind: "text",
    description:
      "Replaced with the current club name when the content renders.",
    example: "{{club-name}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "currency",
    kind: "text",
    description:
      "Replaced with the current currency code when the content renders.",
    example: "{{currency}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "lodge-capacity",
    kind: "text",
    description:
      "Replaced with the current lodge capacity when the content renders.",
    example: "{{lodge-capacity}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "facebook-url",
    kind: "text",
    description:
      "Replaced with the club's Facebook URL from the club configuration " +
      "(falling back to the public website URL when no Facebook link is " +
      "configured). Use it as a link address so the link follows the " +
      "configuration.",
    example: "{{facebook-url}}",
    allowsLegacySingleBrace: false,
    contexts: ["site-footer"],
  },
];

/** All tokens available in the given editor context, in catalogue order. */
export function tokensForContext(
  context: TokenContextId,
): HtmlTokenDefinition[] {
  return HTML_TOKEN_CATALOGUE.filter((definition) =>
    definition.contexts.includes(context),
  );
}

/** Names of every embed token (double-brace form always accepted). */
export function embedTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "embed",
  ).map((definition) => definition.token);
}

/** Embed tokens that still accept the legacy single-brace {token} form. */
export function legacySingleBraceTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) =>
      definition.kind === "embed" && definition.allowsLegacySingleBrace,
  ).map((definition) => definition.token);
}

/** Names of every inline text token. */
export function textTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "text",
  ).map((definition) => definition.token);
}
