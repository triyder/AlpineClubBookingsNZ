import "server-only";

import { revalidatePath } from "next/cache";

/** Invalidates every PageContent-backed public route after an authority write. */
export function revalidatePublicPageContent(): void {
  revalidatePath("/", "layout");
}
