import type { Metadata } from "next";
import { DisplayScreen } from "./display-screen";
import "./display.css";

// The lobby TV display page (fork issue #32, epic #25): a full-screen,
// read-only, non-interactive surface. Auth is the display-token cookie
// (ADR-001) — an unpaired browser sees only a pairing code. The lobbyDisplay
// module flag gates this whole route at the proxy (404 when off).

export const metadata: Metadata = {
  title: "Lobby display",
  robots: { index: false, follow: false },
};

// Must render per-request (fork issue #54): the CSP is nonce-only in
// production and Next stamps the nonce into its inline bootstrap scripts
// only during dynamic rendering. A statically prerendered /display ships
// unnonced inline scripts, the browser blocks them, and this client-shell
// page stays blank on real TVs.
export const dynamic = "force-dynamic";

export default function DisplayPage() {
  return <DisplayScreen />;
}
