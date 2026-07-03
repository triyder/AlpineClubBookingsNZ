"use client";

import { createContext, type ReactNode } from "react";

const CspNonceContext = createContext<string | undefined>(undefined);

export function CspNonceProvider({
  children,
  nonce,
}: {
  children: ReactNode;
  nonce?: string;
}) {
  return (
    <CspNonceContext.Provider value={nonce}>
      {children}
    </CspNonceContext.Provider>
  );
}
