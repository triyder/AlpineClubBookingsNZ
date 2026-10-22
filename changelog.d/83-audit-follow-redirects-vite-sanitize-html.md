- **Three dependency advisories closed in the lockfile (triyder/AlpineClubBookingsNZ#83).**
  `follow-redirects` 1.16.1 and `vite` 8.3.5 (pinned as a development
  dependency, the vitest peer) clear the two high advisories thatskiff33's
  #4266 fixed; `sanitize-html` 2.18.1 clears the moderate one from #4281. The
  braces mitigation record (#3843) is refreshed on unchanged evidence — one
  `braces@3.0.3` copy on the same `eslint-config-next` development path — with
  the new lockfile digest and an expiry of 5 November 2026.
