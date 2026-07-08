import { BackLink } from "@/components/admin/back-link";
import { ImageManagerClient } from "./image-manager-client";

export default function ImageManagerPage() {
  return (
    <div className="space-y-6">
      <BackLink href="/admin/appearance" label="Site Appearance & Content" />
      <ImageManagerClient />
    </div>
  );
}
