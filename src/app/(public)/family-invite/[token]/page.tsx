import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerInviteClaimCard } from "@/components/partner-invite-claim-card";
import { auth } from "@/lib/auth";
import { buildLoginPath } from "@/lib/auth-redirect";
import { prisma } from "@/lib/prisma";
import { getPartnerInviteTokenForClaim } from "@/lib/partner-invite-token";
import { normalizeInvitedEmail } from "@/lib/partner-invite-token-policy";
import { CLUB_NAME } from "@/config/club-identity";

export const dynamic = "force-dynamic";

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function PartnerInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [session, view] = await Promise.all([
    auth(),
    getPartnerInviteTokenForClaim(token),
  ]);

  if (view.status === "invalid") {
    return (
      <Shell title="Invitation link not found">
        <p>This invitation link is invalid or is no longer available.</p>
        <p>
          If you reached this page from an older email, ask the person who
          invited you to send a fresh invitation.
        </p>
      </Shell>
    );
  }

  if (view.status === "expired") {
    return (
      <Shell title="Invitation expired">
        <p>This invitation link has expired.</p>
        <p>
          Ask the person who invited you to send a fresh invitation from their
          family group.
        </p>
      </Shell>
    );
  }

  if (view.status === "claimed") {
    return (
      <Shell title="Invitation already used">
        <p>This invitation has already been accepted.</p>
        <p>
          If you have a {CLUB_NAME} account, your family group is available from
          your profile page.
        </p>
      </Shell>
    );
  }

  if (view.status === "group_unavailable") {
    return (
      <Shell title="Family group not ready yet">
        <p>
          The family group for this invitation is not available yet. It still
          needs to be approved by an administrator, or it is no longer active.
        </p>
        <p>Check back later, or contact the person who invited you.</p>
      </Shell>
    );
  }

  const groupName = view.groupName ?? "a family group";

  // Not signed in: route the recipient through the normal membership process
  // (do not fork a second registration path), then back to this same link.
  if (!session?.user?.id) {
    return (
      <Shell title="Family group invitation">
        <p>
          You have been invited to join the family group{" "}
          <strong>{groupName}</strong> at {CLUB_NAME}.
        </p>
        <p>
          To accept, you first need a {CLUB_NAME} membership account. Apply for
          membership using the invited email address
          {" "}
          <strong>{view.invitedEmail}</strong>. Once your login is active,
          return to this link to join the group.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild>
            <Link href="/join/apply">Apply for membership</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={buildLoginPath(`/family-invite/${encodeURIComponent(token)}`)}>
              I already have an account
            </Link>
          </Button>
        </div>
      </Shell>
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });

  // Signed in with a different email than the invite was sent to: a forwarded
  // link cannot be used to join a stranger's group.
  if (!member || normalizeInvitedEmail(member.email) !== view.invitedEmail) {
    return (
      <Shell title="Family group invitation">
        <p>
          This invitation was sent to <strong>{view.invitedEmail}</strong>.
        </p>
        <p>
          Sign in with that account to accept the invitation to join{" "}
          <strong>{groupName}</strong>.
        </p>
        <div className="pt-2">
          <Button asChild variant="outline">
            <Link href={buildLoginPath(`/family-invite/${encodeURIComponent(token)}`)}>
              Sign in with a different account
            </Link>
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Join family group">
      <p>
        You have been invited to join the family group{" "}
        <strong>{groupName}</strong>.
      </p>
      <p>
        Accepting adds you to the group so you can be included when the group
        makes bookings.
      </p>
      {view.createPartnerLink && (
        <p>
          Accepting will <strong>also record you as{" "}
          {view.inviterName ? `${view.inviterName}'s` : "your inviter's"}{" "}
          partner</strong> (husband, wife, or partner) with the club. If that is
          not right, don&apos;t accept — contact the club instead. You can remove
          a recorded partner relationship from your profile at any time.
        </p>
      )}
      <PartnerInviteClaimCard token={token} groupName={groupName} />
    </Shell>
  );
}
