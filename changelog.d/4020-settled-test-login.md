- **Browser tests finish two-factor sign-in before continuing (#4020).** The shared login helpers wait for the visible challenge and authenticated page, so a delayed verification redirect cannot leave later checks using an incomplete session.

  After two-factor completion, the helper re-enters the returned destination through its server gate before accepting the authenticated layout.
