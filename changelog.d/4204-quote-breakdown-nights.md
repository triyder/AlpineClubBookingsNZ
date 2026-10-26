- **A booking edit's price breakdown now adds up to the price change it quotes
  (#4197).** When a member or officer edits a booking, the line explaining a
  date or guest-stay change was worked out separately from the quoted total:
  it treated each guest's stay as one unbroken run of nights at today's rates.
  A guest with gaps in their nights, or nights already paid at an earlier
  price, could therefore be shown a different amount from the real change. The
  line, and each added guest's line, now come from the same pricing the total
  uses, guest by guest. Moving the whole booking, with every guest moving with
  it, reads as a date change; guests moving by different amounts, or a guest
  whose dates look the same but whose nights change, such as one whose gap is
  filled, get a "Guest stay range change" line; and a price that moves
  with no date change reads "Price recalculated (rate difference)". A re-rated
  guest's line says when it includes their date change. Promo codes now add
  up too: a kept code shows one "Promo 'X' (re-priced)" line for what changed,
  even when it now discounts nothing; a replaced code shows the new code and
  "Previous promo 'X' reversed"; a code that is removed or no longer applies
  shows "Removed promo 'X'"; and a refused code shows its refusal while the
  totals keep the booking's existing discount, which is what saving would
  leave. An officer can no longer link a guest to a member and change their
  other-lodge rate in the same change, which would have re-rated them twice.
  On a stay already under way,
  a removed guest's refund is shown once instead of twice, and the unchanged
  promo discount is no longer listed. The amount charged is unchanged.
