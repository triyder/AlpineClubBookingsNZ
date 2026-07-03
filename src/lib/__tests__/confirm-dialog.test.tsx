// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

function Harness() {
  const { confirm, confirmDialog } = useConfirm();
  const [result, setResult] = useState<string>("none");

  return (
    <div>
      {confirmDialog}
      <button
        type="button"
        onClick={async () => {
          const confirmed = await confirm({
            title: "Delete this thing?",
            description: "This cannot be undone.",
            confirmLabel: "Delete",
            destructive: true,
          });
          setResult(confirmed ? "confirmed" : "cancelled");
        }}
      >
        Trigger
      </button>
      <output>{result}</output>
    </div>
  );
}

describe("useConfirm", () => {
  it("resolves true when the user confirms", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Delete this thing?")).not.toBeNull();
    expect(screen.getByText("This cannot be undone.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("confirmed")).not.toBeNull(),
    );
    expect(screen.queryByText("Delete this thing?")).toBeNull();
  });

  it("resolves false when the user cancels", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByText("cancelled")).not.toBeNull(),
    );
    expect(screen.queryByText("Delete this thing?")).toBeNull();
  });
});
