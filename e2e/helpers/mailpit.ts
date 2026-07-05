// Reads captured email back from the staging mailpit SMTP capture container
// (docker-compose.staging.yml). The staging app relays all outbound mail to
// mailpit (USE_SMTP_RELAY), so the email-code two-factor spec can trigger a
// send in the browser and then read the emitted six-digit code here rather than
// depending on a live mail provider. mailpit forwards mail nowhere, so no real
// inbox is ever contacted.
//
// mailpit HTTP API shape (v1), confirmed against axllent/mailpit:v1.30.3:
//   GET    /api/v1/messages          -> { messages: [{ ID, To: [{ Address }], Subject, Created }], ... } (newest first)
//   GET    /api/v1/message/{ID}       -> { HTML, Text, ... }
//   DELETE /api/v1/messages           -> 200 (deletes all)

const DEFAULT_MAILPIT_URL = "http://localhost:8025";

function mailpitBaseUrl(): string {
  return (process.env.E2E_MAILPIT_URL ?? DEFAULT_MAILPIT_URL).replace(/\/$/, "");
}

type MailpitSummary = {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
  Created: string;
};

type MailpitMessage = {
  HTML?: string;
  Text?: string;
};

async function mailpitFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${mailpitBaseUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `mailpit ${init?.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

// Deletes every captured message. Called before triggering a fresh send so the
// next matching message is unambiguously the one this step produced. The suite
// runs serially (playwright workers: 1), so no other spec is mid-send.
export async function clearMailbox(): Promise<void> {
  await mailpitFetch("/api/v1/messages", { method: "DELETE" });
}

function toMatches(message: MailpitSummary, recipient: string): boolean {
  const target = recipient.toLowerCase();
  return (message.To ?? []).some(
    (addr) => addr.Address?.toLowerCase() === target,
  );
}

// Pulls the six-digit code out of the two-factor email. The template renders it
// as `<strong ...>123456</strong>` (src/lib/email-templates.ts), so anchoring on
// the strong tag is exact — it cannot grab a stray digit run elsewhere in the
// email-HTML wrapper. The plaintext fallback covers mailpit's auto-generated
// text part.
function extractSixDigitCode(message: MailpitMessage): string | null {
  const html = message.HTML ?? "";
  const tagMatch = html.match(/<strong[^>]*>\s*(\d{6})\s*<\/strong>/);
  if (tagMatch) return tagMatch[1];

  const text = message.Text ?? "";
  const textMatch = text.match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
  if (textMatch) return textMatch[1];

  return null;
}

async function findLatestMatch(
  recipient: string,
  subjectFragment: string,
): Promise<string | null> {
  const list = (await (await mailpitFetch("/api/v1/messages")).json()) as {
    messages: MailpitSummary[];
  };
  const subject = subjectFragment.toLowerCase();
  const match = list.messages.find(
    (message) =>
      toMatches(message, recipient) &&
      (message.Subject ?? "").toLowerCase().includes(subject),
  );
  if (!match) return null;

  const full = (await (
    await mailpitFetch(`/api/v1/message/${match.ID}`)
  ).json()) as MailpitMessage;
  return extractSixDigitCode(full);
}

// Polls mailpit until a two-factor code email addressed to `recipient` arrives,
// then returns its six-digit code. Clear the mailbox before the send that
// produces it so a stale code cannot be read.
export async function waitForTwoFactorCode(
  recipient: string,
  { timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const code = await findLatestMatch(recipient, "two-factor code");
      if (code) return code;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a two-factor code email to ${recipient} ` +
      `via mailpit at ${mailpitBaseUrl()}. Is the mailpit container up and is the ` +
      `staging app configured for USE_SMTP_RELAY -> mailpit?${suffix}`,
  );
}
