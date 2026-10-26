import type { Page, Response } from "@playwright/test";

import { wizardProgressPath } from "../../src/lib/integration-wizard-progress-routes";

/**
 * Resolves with the response to the integration wizard's save of `stepId` as
 * its resume cursor (`POST` to the route `wizardProgressPath` names, #4409). Call it
 * BEFORE the click that moves the wizard onto `stepId`, and await it before the
 * page navigates away.
 *
 * A spec that leaves the page from a wizard step (the Xero Connect step's OAuth
 * round-trip) comes back to whatever step the server has stored, and the shell
 * saves that cursor through a one-at-a-time queue (#4014). Waiting here is the precondition a
 * real operator meets by taking more than a few milliseconds to press Connect;
 * without it the post-OAuth page can read the cursor before the save of the
 * step the spec left from has landed. The caller asserts the response is OK, so
 * a failed save fails loudly rather than as a later timeout.
 */
export function wizardCursorSave(
  page: Page,
  wizardId: string,
  stepId: string,
): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      const request = response.request();
      if (request.method() !== "POST") return false;
      if (new URL(response.url()).pathname !== wizardProgressPath(wizardId)) return false;
      const body = request.postDataJSON() as {
        wizardId?: unknown;
        currentStepId?: unknown;
      } | null;
      return body?.wizardId === wizardId && body?.currentStepId === stepId;
    },
    { timeout: 15_000 },
  );
}
