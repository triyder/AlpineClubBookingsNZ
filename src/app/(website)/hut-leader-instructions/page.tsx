import type { Metadata } from "next";
import { HutLeaderInstructionsClient } from "./hut-leader-instructions-client";

export const metadata: Metadata = {
  title: "Lodge instructions",
  // Public, PIN-gated, per-assignment — never index it.
  robots: { index: false, follow: false },
};

// Remote pre-arrival lodge-instructions view for non-login hut leaders (#1642).
// Public route (no login gate): the assignment id arrives as `?a=` from the
// assignment email link, and the client verifies it together with the kiosk
// PIN via /api/lodge/instructions/preview before any instructions are shown.
export default async function HutLeaderInstructionsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = searchParams ? await searchParams : undefined;
  const raw = resolved?.a;
  const assignmentId = typeof raw === "string" && raw.length > 0 ? raw : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <HutLeaderInstructionsClient assignmentId={assignmentId} />
    </div>
  );
}
