import "server-only";

import { requireAdmin } from "@/lib/session-guards";
import {
  answerWizardProgressGet,
  answerWizardProgressPost,
} from "@/lib/integration-wizard-progress-http";
import { WIZARD_PROGRESS_ROUTES } from "@/lib/integration-wizard-progress-routes";

// Resume cursor for the database-backup setup wizard (#2227), owner decision
// #4409 (26 Oct 2026): it remembers its step like the other setup wizards.
//
// Its own route, under the SUPPORT area the Backups surfaces already belong to
// (`/api/admin/backups` in admin-permissions.ts), rather than a support branch
// inside the finance integrations route: each route's gate stays one literal
// the authorization proof can read. Support view reads the cursor; support edit
// saves it. The cursor is only a resume hint (which step, which steps
// acknowledged): every step re-derives its gate from live server truth, and the
// S3 credentials and destination stay Full Admin in their own write routes.
// Like every wizard cursor it is one row for the whole install.
const WIZARD_IDS = WIZARD_PROGRESS_ROUTES.backups.wizardIds;

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;
  return answerWizardProgressGet(request, WIZARD_IDS);
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  return answerWizardProgressPost(request, WIZARD_IDS, guard.session.user.id);
}
