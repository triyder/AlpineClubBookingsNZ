"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { UI_THEME_STORAGE_KEY } from "@/components/theme-switcher";

interface AppThemeProviderProps {
  children: ReactNode;
  nonce?: string;
}

export function AppThemeProvider({
  children,
  nonce,
}: AppThemeProviderProps) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableColorScheme
      enableSystem
      nonce={nonce}
      storageKey={UI_THEME_STORAGE_KEY}
    >
      {children}
    </ThemeProvider>
  );
}
