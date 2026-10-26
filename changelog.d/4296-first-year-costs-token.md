- **A club's Join page can now show what it costs to join as one figure per kind
  of member (#4295).** Until now the page could only show the joining fee and
  the annual subscription in two separate blocks, and the visitor had to add
  them up. A new `{{first-year-costs}}` block shows the total directly: the
  joining fee plus the first year's subscription, for each publicly listed
  membership type and age group, for example "Adult $390, Youth $155, Family
  $500".

  The totals are worked out from the same fee schedules and exemptions the
  invoicing uses, so a new schedule is reflected from the day it takes effect,
  with nothing to edit. A page served from the site's short cache can lag a
  schedule that starts today by a few minutes. A family is shown as its joining
  fee plus its flat per-family subscription, so the family rule is whatever the
  club has set in the Fees screen; a per-member family fee is not multiplied by
  the number of members, so a club should price its family with a per-family
  fee. A group that needs a subscription but has no annual fee set is left out
  rather than shown at its joining fee alone, which would look like the whole
  cost, and a group exempt from the subscription (for example young children)
  shows its joining fee only. A subscription that is reduced for people joining
  part-way through the season is shown as "up to".

  The block only appears when both the Joining fees and Annual membership fees
  visibility switches in Page Content are on. Nothing changes for a club that
  does not use the block, and nothing about invoicing or fees changes.
