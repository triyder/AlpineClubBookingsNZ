// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStatusPanel } from "@/app/(admin)/admin/xero/_components/connection-status-panel";

describe("ConnectionStatusPanel", () => {
  it("does not imply finance report scope readiness from token presence", () => {
    render(
      <ConnectionStatusPanel
        status={{
          connected: true,
          tenantId: "tenant-123",
          tokenExpiresAt: "2026-04-20T00:00:00.000Z",
        }}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("Xero is connected and ready for syncing."),
    ).toBeNull();
    expect(
      screen.getByText(/Xero is connected for operational syncs/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Finance report scope readiness is verified/),
    ).toBeTruthy();
  });
});
