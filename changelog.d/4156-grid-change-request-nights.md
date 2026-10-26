- **A change request sent from the booking editor's night-by-night grid keeps
  each guest's nights (#4088).** When a member chose individual nights for their
  guests and sent the change as a request, the request quietly dropped those
  nights. On a finished stay, approving it then put every guest on the booking's
  full dates and charged for nights nobody asked for.

  The request now records each guest's exact nights, gaps included, and
  approving applies and prices exactly those nights. If a guest's nights were
  changed on the booking after the member sent the request, nothing is applied
  and the officer is told the booking has changed. Requests sent with ordinary
  Date In and Date Out work as before.

  The officer's card on Booking Requests now counts and lists the nights each
  guest is asked for, in runs (for example "3 nights: 3 Jul – 4 Jul, 6 Jul"),
  marking a guest whose nights would not change, and one whose Date In and
  Date Out would fill the gaps in their stay. A request with a night that isn't a real date
  is refused in plain words, and a refusal about a guest's dates names the
  guest rather than their place in the list.
