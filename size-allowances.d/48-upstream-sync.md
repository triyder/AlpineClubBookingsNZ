# Upstream convergence sync: one file grew

The sync merge lands upstream's #3108 review fix in the email-templates save
route, which added the marker-free validation derivation and its comment.
Splitting the route inside a sync would diverge it from upstream and make
every future sync conflict there — strictly worse than declaring the length
upstream itself carries.

file: src/app/api/admin/email-templates/route.ts
lines: 668
reason: upstream's #3108 ultrareview fix (validation reads the marker-free
derivation of a rich body) composed onto this fork's base; identical to the
length upstream's own tree carries for this file.
