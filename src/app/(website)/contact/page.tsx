import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { clubIdentity } from "@/config/club-identity";

export default function ContactPage() {
  return <ContactPageClient club={clubIdentity} />;
}
