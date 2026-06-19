import type { Metadata } from "next";
import { clubIdentity } from "@/config/club-identity";
import { GroupJoinPageClient } from "@/app/(website)/join/[code]/group-join-page-client";

export const metadata: Metadata = {
  title: "Join a group booking",
  robots: { index: false, follow: false },
};

export default async function GroupJoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <GroupJoinPageClient club={clubIdentity} code={code} />;
}
