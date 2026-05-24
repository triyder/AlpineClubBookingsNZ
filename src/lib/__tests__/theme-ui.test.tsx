// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppThemeProvider } from "@/components/app-theme-provider";
import {
  ThemeSwitcher,
  UI_THEME_STORAGE_KEY,
} from "@/components/theme-switcher";
import RootLayout from "@/app/layout";

const {
  headersMock,
  setThemeMock,
  themeProviderMock,
  useThemeMock,
} = vi.hoisted(() => ({
  headersMock: vi.fn(),
  setThemeMock: vi.fn(),
  themeProviderMock: vi.fn(({ children }: { children: ReactNode }) => children),
  useThemeMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: themeProviderMock,
  useTheme: useThemeMock,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

describe("AppThemeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersMock.mockResolvedValue(new Headers());
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "system",
    });
  });

  it("configures next-themes with browser storage and CSP nonce support", () => {
    render(
      <AppThemeProvider nonce="nonce-123">
        <span>themed content</span>
      </AppThemeProvider>
    );

    expect(themeProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute: "class",
        defaultTheme: "system",
        disableTransitionOnChange: true,
        enableColorScheme: true,
        enableSystem: true,
        nonce: "nonce-123",
        storageKey: UI_THEME_STORAGE_KEY,
      }),
      undefined
    );
  });

  it("receives the root layout CSP nonce from the x-nonce header", async () => {
    headersMock.mockResolvedValue(new Headers({ "x-nonce": "layout-nonce" }));

    render(await RootLayout({ children: <span>page content</span> }));

    expect(themeProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: "layout-nonce",
        storageKey: UI_THEME_STORAGE_KEY,
      }),
      undefined
    );
  });
});

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "dark",
    });
  });

  it("renders Light, Dark, and Follow system choices", () => {
    render(<ThemeSwitcher />);

    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Follow system" })
    ).toBeTruthy();
  });

  it("updates next-themes when a choice is selected", () => {
    render(<ThemeSwitcher />);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(setThemeMock).toHaveBeenCalledWith("light");
  });
});
