import "server-only";

import { revalidatePath } from "next/cache";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

/** Invalidates every PageContent-backed public route after an authority write. */
export function revalidatePublicPageContent(): void {
  revalidatePath("/", "layout");
  invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.capacity);
}
