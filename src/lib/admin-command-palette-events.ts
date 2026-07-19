/**
 * Cross-tree wiring for the admin command palette (#2092). The palette is
 * mounted once in the admin layout, but its "Search…" trigger lives in the
 * sidebar header — a separate subtree. A window CustomEvent decouples the two
 * without threading a context provider through the layout. The palette also
 * opens directly on Ctrl/Cmd-K.
 */
export const ADMIN_COMMAND_PALETTE_OPEN_EVENT = "admin:open-command-palette";

/** Dispatch the open event; safe to call from any admin client component. */
export function openAdminCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ADMIN_COMMAND_PALETTE_OPEN_EVENT));
}
