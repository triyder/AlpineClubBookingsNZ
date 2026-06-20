import type { Metadata } from "next";
import { clubIdentity } from "@/config/club-identity";
import { GroupJoinVerifyPageClient } from "@/app/(website)/join/verify/[token]/group-join-verify-page-client";

export const metadata: Metadata = {
  title: "Confirm your group booking spot",
  robots: { index: false, follow: false },
};

export default async function GroupJoinVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <GroupJoinVerifyPageClient club={clubIdentity} token={token} />;
}
