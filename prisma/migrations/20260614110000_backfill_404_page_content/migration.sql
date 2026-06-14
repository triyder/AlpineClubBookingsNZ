-- Backfill the 404 PageContent row for existing deployments that ran
-- migrations without the seed (or before the 404 entry was added to
-- starterPageContent). ON CONFLICT DO NOTHING keeps this safe to re-run on
-- databases where the seed has already created the row.
--
-- Keep these values in sync with starterPageContent in prisma/seed.ts
-- (enforced by src/lib/__tests__/page-content-starter-backfill.test.ts).
INSERT INTO "PageContent"
  ("id", "slug", "path", "caption", "menuTitle", "title", "headerText", "sortOrder", "contentHtml", "updatedAt")
VALUES
  (
    'starter-page-404',
    '404',
    '/404',
    'Page not found',
    '',
    'Page Not Found',
    'The page you are looking for does not exist.',
    100,
    '<h2>Page Not Found</h2>',
    CURRENT_TIMESTAMP
  )
ON CONFLICT DO NOTHING;
