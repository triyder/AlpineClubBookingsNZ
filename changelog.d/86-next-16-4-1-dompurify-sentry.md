- **Next.js 16.4.1, Sentry 10.75.2 and DOMPurify 3.4.17 close seven dependency advisories (triyder/AlpineClubBookingsNZ#86).**
  GitHub published advisories on 23 October 2026 against the Next.js release
  the site ran on (two critical, unauthenticated remote code execution, and one
  denial of service), against the Sentry Next.js package, and against the
  DOMPurify copy that PDF export pulls in. All three move to their patched
  releases; nothing in the app's own code changes. The braces mitigation
  record (#3843) is refreshed on unchanged evidence with the new lockfile
  digest. Deployments pick the fix up with the next image build.
