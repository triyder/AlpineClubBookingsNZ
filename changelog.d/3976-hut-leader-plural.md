- **A hut-leader label saved as a plural no longer reads "Hut Leaderss" (#3976).**
  The admin sidebar and a few other screens built the plural by adding an "s"
  to the club's hut-leader label, so a club that had typed "Hut Leaders" saw
  "Hut Leaderss". A label that already ends in "s" is now left as typed.

  The Hut-leader label field (Admin → Appearance → Identity) now says to enter
  the singular, for example "Hut Leader". A club whose label is plural should
  change it to the singular, because the singular wording elsewhere ("held for
  a hut leader") still uses the label exactly as saved.

- **Club identity now opens read-only, with Edit, Save and Cancel (#3976).**
  Under Admin → Appearance → Identity, the club name, short name, hut-leader
  label and Facebook URL fields are read-only until you click **Edit**.
  **Save club identity** only becomes available once something has changed,
  and **Cancel** restores the last saved values. Save and load messages now
  appear at the top of the section instead of as pop-up notifications.
