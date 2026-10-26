- **Keyboard focus now returns to the Edit button after Save or Cancel in
  admin settings sections (#4087).** Saving or cancelling a settings section
  used to drop keyboard and screen-reader users to the top of the page,
  because the button they had just pressed disappeared. Focus now goes back
  to the section's Edit button (or the Add or row Edit button for booking
  periods and minimum-stay policies), or to the section itself when Edit is
  not available. Pages that move to the top after a successful save, such as
  Member fields, still do. A save that fails keeps the section open and puts
  focus back on Save if the browser had dropped it. Mouse users in Chrome and
  Edge also see the Edit button scroll back into view, because those browsers
  focus a button when it is clicked. Nothing needs configuring.
