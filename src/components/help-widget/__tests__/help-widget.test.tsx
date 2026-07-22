// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "@/components/help-widget/help-widget";
import {
  HelpWidgetProvider,
  useHelpWidgetExtras,
  useHelpWidgetHint,
  type HelpWidgetExtras,
} from "@/components/help-widget/help-widget-context";

const mocks = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

function content(overrides: Partial<HelpPageContent> = {}): HelpPageContent {
  return {
    title: "Your dashboard",
    summary: "The member home base.",
    actions: ["Start a booking from Book."],
    questions: [
      { q: "How do I book a stay?", a: "Open Book and pick your nights." },
      { q: "Where are my bookings?", a: "Open My Bookings." },
    ],
    ...overrides,
  };
}

const resolveStub = (help: HelpPageContent) => () => help;

/** Leaf that registers extras/hint into the provider for the merge/hint tests. */
function ExtrasLeaf({
  extras,
  hint,
}: {
  extras?: HelpWidgetExtras;
  hint?: string;
}) {
  // Hooks must run unconditionally.
  useHelpWidgetExtras(extras ?? {});
  useHelpWidgetHint({ group: hint ?? null });
  return null;
}

function openPanel() {
  fireEvent.click(screen.getByTestId("help-widget-launcher"));
}

beforeEach(() => {
  mocks.pathname = "/dashboard";
});

describe("HelpWidget", () => {
  it("renders chips and appends a Q/A pair when a chip is tapped", () => {
    render(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();

    const panel = screen.getByTestId("help-widget-panel");
    fireEvent.click(
      within(panel).getByRole("button", { name: "How do I book a stay?" }),
    );

    // Both the user question bubble and the templated answer are appended.
    expect(
      within(panel).getAllByText("How do I book a stay?").length,
    ).toBeGreaterThan(0);
    expect(
      within(panel).getByText("Open Book and pick your nights."),
    ).toBeTruthy();
    expect(within(panel).getByText("From the help guide")).toBeTruthy();
  });

  it("renders no free-text input while llmEnabled is false", () => {
    render(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("exposes a polite live-region transcript log", () => {
    render(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();

    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
  });

  it("resets to the chip view on route change but keeps the transcript", () => {
    const { rerender } = render(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();

    const panel = screen.getByTestId("help-widget-panel");
    fireEvent.click(
      within(panel).getByRole("button", { name: "How do I book a stay?" }),
    );
    // Move to the Page guide tab so the reset is observable.
    fireEvent.click(within(panel).getByRole("tab", { name: "Page guide" }));
    expect(
      within(panel).getByRole("tab", { name: "Page guide" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    // Navigate.
    mocks.pathname = "/bookings";
    rerender(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );

    // Back on the Ask tab (chips), transcript preserved.
    expect(
      within(panel).getByRole("tab", { name: "Ask" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(
      within(panel).getByText("Open Book and pick your nights."),
    ).toBeTruthy();
  });

  it("merges provider-registered extras: an extra chip appears first", () => {
    render(
      <HelpWidgetProvider>
        <ExtrasLeaf
          extras={{
            questions: [{ q: "Extra question?", a: "Extra answer." }],
            sections: [{ title: "Extra section", details: ["Detail one."] }],
          }}
        />
        <HelpWidget
          surface="member"
          llmEnabled={false}
          resolveHelp={resolveStub(content())}
        />
      </HelpWidgetProvider>,
    );
    openPanel();

    const panel = screen.getByTestId("help-widget-panel");
    const chips = within(panel)
      .getByRole("heading", { name: "Common questions" })
      .parentElement!.querySelectorAll("button");
    // Extras chip is first.
    expect(chips[0].textContent).toContain("Extra question?");

    // The extra section shows in the Page guide view.
    fireEvent.click(within(panel).getByRole("tab", { name: "Page guide" }));
    expect(within(panel).getByText("Extra section")).toBeTruthy();
    expect(within(panel).getByText("Detail one.")).toBeTruthy();
  });

  it("reorders chips to lead with the hinted group", () => {
    const bookContent = content({
      questions: [
        { q: "General question?", a: "General answer." },
        { q: "Dates question?", a: "Dates answer.", group: "dates" },
      ],
    });
    render(
      <HelpWidgetProvider>
        <ExtrasLeaf hint="dates" />
        <HelpWidget
          surface="member"
          llmEnabled={false}
          resolveHelp={resolveStub(bookContent)}
        />
      </HelpWidgetProvider>,
    );
    openPanel();

    const panel = screen.getByTestId("help-widget-panel");
    const chips = within(panel)
      .getByRole("heading", { name: "Common questions" })
      .parentElement!.querySelectorAll("button");
    expect(chips[0].textContent).toContain("Dates question?");
  });

  it("closes on Escape and returns focus to the launcher", () => {
    render(
      <HelpWidget
        surface="member"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
      />,
    );
    openPanel();

    const panel = screen.getByTestId("help-widget-panel");
    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByTestId("help-widget-panel")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByTestId("help-widget-launcher"),
    );
  });

  it("renders the public position variant with the members footer note", () => {
    render(
      <HelpWidget
        surface="public"
        llmEnabled={false}
        resolveHelp={resolveStub(content())}
        position="website"
      />,
    );
    const launcher = screen.getByTestId("help-widget-launcher");
    // Website corner variant: bottom-right on both breakpoints.
    expect(launcher.parentElement?.className).toContain("right-5");

    openPanel();
    expect(
      screen.getByText("Members: sign in for more help."),
    ).toBeTruthy();
  });
});
