# Site Style

Audience: Operator

## What it is

A wizard that sets the brand colours and fonts used by the public website,
member area, and admin area, plus the public logo. Find it at **Admin →
Setup & Configuration → Site Appearance & Content → Site Style**
(`/admin/site-style`). It has no direct sidebar entry — open it from the
**Site Style** card on the Site Appearance & Content hub.

Site Style is a first-run gate: **the public site — including the membership
application form — stays hidden until this style is saved once.** After that,
edits take effect as soon as you save. It is edited under the **content**
permission area.

## When you'd use it

- You've just forked the platform and need to complete the style before the
  public site will show at all.
- Your club is rebranding — new colours, fonts, or logo.
- You want to preview how a colour change looks in the member and admin app
  before committing it.

## Step-by-step

### Work through the style wizard

1. Open **Site Style**. The **Style Setup Wizard** has five steps across the
   top: **Colours**, **Fonts**, **Raw CSS**, **Logo**, and **Review**. A
   **Complete** badge shows once the style has been saved.

   ![The Site Style wizard on the Colours step: the editable brand colour pickers (Primary accent, Charcoal, Deep, Ridge, Mist, Snow, Safety) beside a live public-website and member/admin app preview](../images/admin/admin-site-style.png)

2. On **Colours**, set the editable brand layer — **Primary accent**,
   **Charcoal**, **Deep**, **Ridge**, **Mist**, **Snow**, and **Safety** — as
   hex values. The live preview on the right shows a public heading and the
   member/admin app. The **fixed semantic layer** (success, warning,
   information, danger, and waitlist states) is curated and is **not** editable,
   so operational meaning and contrast stay consistent. Use **Reset neutral** to
   restore the neutral colours.

   Secondary text in the member and admin app — small labels, hints, and
   footnotes — is not one of the colours you pick. It is worked out from your
   **Deep**, **Snow**, **Mist**, and **Charcoal** choices as a softer version of
   the main text colour, so it reads as clearly secondary without becoming hard
   to read. Before it ships, the app measures that softer tone against the
   backgrounds secondary text actually sits on — your page and card background,
   your tinted-row background, and the four built-in coloured notice panels
   (warning, information, success, and danger) — and pulls it back toward the
   main text colour if it would otherwise fall below the accessibility minimum
   on any of them. Hairlines and dividers are not in that list, because text is
   not meant to sit on a divider. If your neutral colours are very close
   together there may be no room to soften it at all, and secondary text will
   look the same as normal text — that is the accessible outcome, and picking
   neutrals with more separation is what restores the distinction.
3. Use **Save and next** to move through **Fonts** (the public and app font
   choices), **Raw CSS** (advanced custom CSS), and **Logo** (upload the public
   logo).
4. On **Review**, confirm and save. The public site becomes visible once the
   style is saved.

## Settings reference

| Wizard step | What it controls | Notes / constraints |
| --- | --- | --- |
| Colours — Primary accent | The main accent for actions and navigation | Hex; glacial teal by default, may be club gold or another accessible brand colour |
| Colours — Charcoal / Deep / Ridge / Mist / Snow | The neutral warmth scale used across the three areas | Hex values |
| Colours — Safety | The safety/emphasis colour | Hex value |
| Fixed semantic layer | Success, warning, information, danger/error, and waitlist states | **Not editable** — curated light/dark pairs |
| Fonts | The public and app font variables | Chosen from the wizard |
| Raw CSS | Advanced custom CSS overrides | Optional; for advanced users |
| Logo | The public logo image | Uploaded on the Logo step |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The public site (and application form) shows nothing | The style has never been saved | Complete the wizard and save once; the **Complete** badge confirms it |
| A status colour won't change | Success/warning/information/danger are the fixed semantic layer | These are intentionally not brand pickers |
| Everything is read-only | Your admin role can view but not edit under the content area | Ask a full admin for content edit access |
| A colour looks low-contrast in the preview | The picked brand colour fails accessibility against text | Choose an accessible brand colour; the preview shows the effect |

## Related links

- Back to the [documentation hub](../README.md).
- Parent hub: [Site Appearance & Content](appearance.md).
- Sibling guides: [Site Content](site-content.md),
  [Page Content](page-content.md), [Image Manager](image-manager.md).
