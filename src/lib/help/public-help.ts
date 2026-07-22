import type { HelpPageContent, HelpPageEntry } from "./types";

/**
 * Public (signed-out) help corpus. Deliberately tiny and generic: it explains
 * how the product works, never invents club policy, and points members at the
 * club's own pages for anything specific. Rules for this file:
 *  - Product mechanics only — how to book, how to join, where to sign in.
 *  - Never state fees, dates, cancellation terms, or any club-specific policy;
 *    defer to the club's own website pages (site menu/footer) and contact page.
 *    Never assert that specific footer content exists — contact details and
 *    quick links are admin-editable and can be saved empty.
 *  - No club proper nouns — always "the club".
 *  - No "AI" or "assistant" wording anywhere in the copy.
 */

function entry(path: string, content: HelpPageContent): HelpPageEntry {
  return { path, content };
}

const homeHelp: HelpPageContent = {
  title: "Welcome",
  summary:
    "This is the club's booking website. Members sign in to book a stay and manage their account; if you are not a member yet, you can apply to join or ask the club for a booking as a guest.",
  actions: [
    "Members: use Log In, then open Book to reserve lodge nights.",
    "Not a member yet: use the Join or Apply link to start a membership application.",
    "Staying as a guest: use the request-a-booking option on the sign-in page to ask the club for a quote.",
  ],
  questions: [
    {
      q: "How do I book a stay?",
      a: "If you are a member, sign in and open Book to choose your nights and confirm. If you are not a member, apply to join first, or use the request-a-booking option to ask the club for a guest quote.",
    },
    {
      q: "How do I become a member?",
      a: "Use the Join or Apply link to fill in a membership application. Applying does not create a login — the club reviews and approves applications before you can sign in.",
    },
    {
      q: "Can I stay without being a member?",
      a: "Yes. From the sign-in page you can request a booking without an account, and the club replies with a secure quote you can accept.",
    },
    {
      q: "Where do I find fees, dates, or the cancellation policy?",
      a: "Those are set by the club. Check the club's own pages in the site menu or footer, or use the club's contact page to ask directly.",
    },
  ],
};

export const publicFallbackHelp: HelpPageContent = {
  title: "Help",
  summary:
    "This is the club's public website. Use the menu to find pages about the club, membership, and contact details. Members sign in to book and manage their account.",
  actions: [
    "Use the site menu to reach the club's public pages.",
    "Members: use Log In to reach your dashboard and booking tools.",
    "Use the club's contact page or the site menu links to ask anything specific.",
  ],
  questions: [
    {
      q: "How do I sign in?",
      a: "Use the Log In link. If you have forgotten your password, use the Forgot password link on the sign-in page.",
    },
    {
      q: "How do I join or book?",
      a: "Use the Join or Apply link to start a membership application, or the request-a-booking option on the sign-in page to ask the club for a guest quote.",
    },
    {
      q: "Who do I contact for something specific?",
      a: "The club sets its own fees, dates, and policies. Use the club's contact page or the pages in the site menu to reach the club directly.",
    },
  ],
};

export const publicHelpEntries: HelpPageEntry[] = [entry("/", homeHelp)];
