// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "@/components/help-widget/help-widget";
import {
  HelpWidgetProvider,
  useHelpWidgetExtras,
  type HelpWidgetExtras,
} from "@/components/help-widget/help-widget-context";
import {
  BUDGET_DISABLED_NOTICE,
  CAP_MESSAGE,
} from "@/components/help-widget/help-free-text-input";

// Assert the LITERAL pinned disclaimer wording (not the imported constant) so
// that any edit to the copy fails this test and is reviewed deliberately.
const AI_DISCLAIMER_LITERAL =
  "AI answers can be wrong — check the page itself for anything important. Your question is sent to Anthropic (US); don't include personal details.";
import {
  BUDGET_EXHAUSTED_COPY,
  FALLBACK_ANSWER,
  RATE_LIMITED_COPY,
  TRUNCATED_NOTE,
} from "@/components/help-widget/use-help-chat";
import {
  PAGE_CONTEXT_MAX_CHARS,
  serializePageContext,
} from "@/components/help-widget/help-page-context";

const mocks = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

function content(overrides: Partial<HelpPageContent> = {}): HelpPageContent {
  return {
    title: "Your dashboard",
    summary: "The member home base.",
    actions: [],
    questions: [{ q: "How do I book a stay?", a: "Open Book." }],
    ...overrides,
  };
}

const resolveStub = (help: HelpPageContent) => () => help;

function openPanel() {
  fireEvent.click(screen.getByTestId("help-widget-launcher"));
}

function renderWidget(surface: "member" | "admin" = "member") {
  render(
    <HelpWidget
      surface={surface}
      llmEnabled
      chatEndpoint="/api/help/chat"
      resolveHelp={resolveStub(content())}
    />,
  );
  openPanel();
  return screen.getByTestId("help-widget-panel");
}

function mockFetchOnce(body: unknown, init: Partial<Response> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function ask(panel: HTMLElement, question: string) {
  const textarea = within(panel).getByRole("textbox");
  fireEvent.change(textarea, { target: { value: question } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

beforeEach(() => {
  mocks.pathname = "/dashboard";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HelpWidget free-text (LLM enabled)", () => {
  it("renders the ask box with the exact disclaimer text", () => {
    const panel = renderWidget();
    expect(within(panel).getByRole("textbox")).toBeTruthy();
    expect(within(panel).getByText(AI_DISCLAIMER_LITERAL)).toBeTruthy();
    expect(
      within(panel).getByPlaceholderText("Ask about this page…"),
    ).toBeTruthy();
  });

  it("does not render the ask box when no endpoint is supplied", () => {
    render(
      <HelpWidget
        surface="member"
        llmEnabled
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("posts the question and renders the answer bubble", async () => {
    const fetchMock = mockFetchOnce({
      status: "answered",
      answer: "Open the Book tab.",
      truncated: false,
      remainingExchanges: 3,
    });
    const panel = renderWidget("admin");

    await ask(panel, "How do I pay?");

    // Optimistic user bubble.
    expect(within(panel).getByText("How do I pay?")).toBeTruthy();
    // Answer bubble.
    await waitFor(() =>
      expect(within(panel).getByText("Open the Book tab.")).toBeTruthy(),
    );

    // POST body carries the AS-BUILT contract fields.
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/help/chat");
    const parsed = JSON.parse((options as RequestInit).body as string);
    expect(parsed).toMatchObject({
      pathname: "/dashboard",
      surface: "admin",
      question: "How do I pay?",
    });
    expect(Array.isArray(parsed.transcript)).toBe(true);
  });

  it("shows the truncated note when the answer was shortened", async () => {
    mockFetchOnce({
      status: "answered",
      answer: "Partial answer",
      truncated: true,
      remainingExchanges: 2,
    });
    const panel = renderWidget();
    await ask(panel, "Tell me everything");
    await waitFor(() =>
      expect(within(panel).getByText(TRUNCATED_NOTE)).toBeTruthy(),
    );
  });

  it.each([
    ["module_off"],
    ["not_configured"],
    ["unavailable"],
  ])(
    "renders the generic fallback and keeps the input enabled for reason %s",
    async (reason) => {
      mockFetchOnce({ status: "fallback", reason });
      const panel = renderWidget();
      await ask(panel, "Anything?");
      await waitFor(() =>
        expect(within(panel).getByText(FALLBACK_ANSWER)).toBeTruthy(),
      );
      // Input stays available for transient reasons.
      expect(within(panel).getByRole("textbox")).toBeTruthy();
    },
  );

  it("disables the input for the session on budget_exhausted", async () => {
    mockFetchOnce({ status: "fallback", reason: "budget_exhausted" });
    const panel = renderWidget();
    await ask(panel, "Anything?");
    await waitFor(() =>
      expect(within(panel).getByText(BUDGET_EXHAUSTED_COPY)).toBeTruthy(),
    );
    // The textarea is replaced by the disabled notice.
    expect(within(panel).getByText(BUDGET_DISABLED_NOTICE)).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
  });

  it("shows the wait copy on a 429 and keeps the input enabled", async () => {
    mockFetchOnce(null, { ok: false, status: 429 });
    const panel = renderWidget();
    await ask(panel, "Anything?");
    await waitFor(() =>
      expect(within(panel).getByText(RATE_LIMITED_COPY)).toBeTruthy(),
    );
    expect(within(panel).getByRole("textbox")).toBeTruthy();
  });

  it("renders the generic fallback on a 5xx error", async () => {
    mockFetchOnce({ error: "boom" }, { ok: false, status: 500 });
    const panel = renderWidget();
    await ask(panel, "Anything?");
    await waitFor(() =>
      expect(within(panel).getByText(FALLBACK_ANSWER)).toBeTruthy(),
    );
    expect(within(panel).getByRole("textbox")).toBeTruthy();
  });

  it("caps the conversation and offers Start new chat that resets", async () => {
    mockFetchOnce({
      status: "answered",
      answer: "Last answer",
      truncated: false,
      remainingExchanges: 0,
    });
    const panel = renderWidget();
    await ask(panel, "final question");
    await waitFor(() =>
      expect(within(panel).getByText("Last answer")).toBeTruthy(),
    );
    // Input replaced by the cap message + Start new chat.
    expect(within(panel).getByText(CAP_MESSAGE)).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();

    fireEvent.click(
      within(panel).getByRole("button", { name: "Start new chat" }),
    );
    // Transcript cleared and the input returns.
    await waitFor(() =>
      expect(within(panel).getByRole("textbox")).toBeTruthy(),
    );
    expect(within(panel).queryByText("Last answer")).toBeNull();
  });

  it("caps the sent transcript to the last 8 turns", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      // remainingExchanges high so the cap never trips during the loop.
      json: async () => ({
        status: "answered",
        answer: "OK",
        truncated: false,
        remainingExchanges: 9,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const panel = renderWidget();

    for (let i = 1; i <= 6; i += 1) {
      await ask(panel, `question ${i}`);
      await waitFor(() =>
        expect(within(panel).getAllByText("OK").length).toBe(i),
      );
    }

    const lastCall = fetchMock.mock.calls.at(-1)!;
    const parsed = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(parsed.transcript.length).toBe(8);
  });

  it("includes serialized page-context from registered extras", async () => {
    const fetchMock = mockFetchOnce({
      status: "answered",
      answer: "ctx",
      truncated: false,
      remainingExchanges: 3,
    });

    function ExtrasLeaf({ extras }: { extras: HelpWidgetExtras }) {
      useHelpWidgetExtras(extras);
      return null;
    }

    render(
      <HelpWidgetProvider>
        <ExtrasLeaf
          extras={{
            sections: [
              { title: "Refund schedule", details: ["50% before 7 days"] },
            ],
            questions: [{ q: "Can I cancel?", a: "Yes, up to 7 days." }],
          }}
        />
        <HelpWidget
          surface="member"
          llmEnabled
          chatEndpoint="/api/help/chat"
          resolveHelp={resolveStub(content())}
        />
      </HelpWidgetProvider>,
    );
    openPanel();
    const panel = screen.getByTestId("help-widget-panel");
    await ask(panel, "cancel?");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const parsed = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(parsed.pageContext).toContain("Refund schedule");
    expect(parsed.pageContext).toContain("Can I cancel?");
  });

  it("does not fire a second fetch while one is in flight", async () => {
    // A fetch that never settles keeps the hook in its pending state.
    let releaseFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const panel = renderWidget();

    await ask(panel, "first question");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A second submit while the first is still in flight must be a no-op.
    await ask(panel, "second question");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the first request settle so nothing dangles.
    releaseFetch({
      ok: true,
      status: 200,
      json: async () => ({
        status: "answered",
        answer: "done",
        truncated: false,
        remainingExchanges: 3,
      }),
    });
    await waitFor(() =>
      expect(within(panel).getByText("done")).toBeTruthy(),
    );
  });

  it("resends a clean paired transcript after a failed exchange", async () => {
    // Curated (fromGuide) pair + a failed free-text (429), then a successful
    // resend. The POSTed transcript must carry neither the curated pair nor the
    // unpaired user turn left by the failed exchange.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => null })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "answered",
          answer: "Second answer",
          truncated: false,
          remainingExchanges: 3,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const panel = renderWidget();

    // Curated chip → instant fromGuide pair, no fetch.
    fireEvent.click(
      within(panel).getByRole("button", { name: "How do I book a stay?" }),
    );
    expect(within(panel).getByText("Open Book.")).toBeTruthy();

    // Failed free-text exchange (rate limited).
    await ask(panel, "failing question");
    await waitFor(() =>
      expect(within(panel).getByText(RATE_LIMITED_COPY)).toBeTruthy(),
    );

    // Resend — the call we deep-assert.
    await ask(panel, "good question");
    await waitFor(() =>
      expect(within(panel).getByText("Second answer")).toBeTruthy(),
    );

    const resendCall = fetchMock.mock.calls.at(-1)!;
    const parsed = JSON.parse((resendCall[1] as RequestInit).body as string);
    expect(parsed.question).toBe("good question");
    // No unpaired user turn and no curated pair leaked into the transcript.
    expect(parsed.transcript).toEqual([]);
    const contents = (parsed.transcript as Array<{ content: string }>).map(
      (turn) => turn.content,
    );
    expect(contents).not.toContain("failing question");
    expect(contents).not.toContain("How do I book a stay?");
    expect(contents).not.toContain("Open Book.");
  });
});

describe("serializePageContext", () => {
  it("returns undefined for empty extras", () => {
    expect(serializePageContext({})).toBeUndefined();
    expect(serializePageContext({ sections: [], questions: [] })).toBeUndefined();
  });

  it("serializes sections and questions to plain text", () => {
    const text = serializePageContext({
      sections: [{ title: "Section A", details: ["Detail one", "Detail two"] }],
      questions: [{ q: "Q1?", a: "A1." }],
    });
    expect(text).toContain("Section A");
    expect(text).toContain("- Detail one");
    expect(text).toContain("Q: Q1?");
    expect(text).toContain("A: A1.");
  });

  it("caps the output under the zod 4000 bound", () => {
    const big = "x".repeat(9000);
    const text = serializePageContext({
      sections: [{ title: big, details: [] }],
    });
    expect(text!.length).toBe(PAGE_CONTEXT_MAX_CHARS);
  });
});
