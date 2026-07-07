// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestForm } from "@/components/guest-form";

describe("GuestForm", () => {
  beforeEach(() => {
    global.fetch = vi.fn(
      async () => new Response("{}", { status: 500 }),
    ) as unknown as typeof fetch;
  });

  it("labels added rows as non-member guests and dims linked-member age categories", () => {
    const onGuestsChange = vi.fn();
    const { container } = render(
      <GuestForm
        guests={[
          {
            firstName: "Ari",
            lastName: "Family",
            ageTier: "CHILD",
            isMember: true,
            memberId: "member-child",
          },
        ]}
        onGuestsChange={onGuestsChange}
        maxGuests={6}
      />,
    );

    expect(
      screen.getByRole("button", { name: "+ Add Non-Member Guest" }),
    ).toBeTruthy();

    const ageCategory = container.querySelector("select");
    expect(ageCategory).not.toBeNull();
    expect((ageCategory as HTMLSelectElement).disabled).toBe(true);
    expect(ageCategory?.className).toContain("disabled:cursor-not-allowed");
    expect(ageCategory?.className).toContain("disabled:opacity-50");
  });
});
