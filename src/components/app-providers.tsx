"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { AppThemeProvider } from "@/components/app-theme-provider";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { CspNonceProvider } from "@/components/security/csp-nonce-provider";
import { Toaster } from "@/components/ui/sonner";
import type { ClubIdentity } from "@/config/club-identity-types";

interface AppProvidersProps {
  children: ReactNode;
  clubIdentity: ClubIdentity;
  nonce?: string;
}

export function AppProviders({
  children,
  clubIdentity,
  nonce,
}: AppProvidersProps) {
  return (
    <CspNonceProvider nonce={nonce}>
      <AppThemeProvider nonce={nonce}>
        <ClubIdentityProvider value={clubIdentity}>
          <SessionProvider>{children}</SessionProvider>
          <Toaster richColors position="top-right" />
        </ClubIdentityProvider>
      </AppThemeProvider>
    </CspNonceProvider>
  );
}
