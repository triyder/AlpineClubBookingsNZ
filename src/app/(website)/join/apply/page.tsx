import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { clubIdentity } from "@/config/club-identity";

export default function JoinApplyPage() {
  return <JoinApplyPageClient club={clubIdentity} />;
}
