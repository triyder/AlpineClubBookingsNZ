// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigationState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

import { WebsiteMobileMenu } from "@/components/website-mobile-menu";

function renderMenu() {
  return render(
    <WebsiteMobileMenu
      isAuthenticated={false}
      clubName="Alpine Club"
      navLinks={[
        { href: "/", label: "Home" },
        { href: "/about", label: "About" },
      ]}
      bookingsHref="/login?next=/book"
      dashboardHref="/login"
    />,
  );
}

function getDetails(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Mobile menu details element was not rendered");
  }
  return details;
}

describe("WebsiteMobileMenu", () => {
  beforeEach(() => {
    navigationState.pathname = "/";
  });

  it("closes when a mobile menu link is clicked", () => {
    const { container } = renderMenu();
    const details = getDetails(container);
    details.open = true;
    const link = screen.getByRole("link", { name: "About" });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(link);

    expect(details.open).toBe(false);
  });

  it("closes when the current route changes", async () => {
    const view = renderMenu();
    const details = getDetails(view.container);
    details.open = true;

    navigationState.pathname = "/about";
    view.rerender(
      <WebsiteMobileMenu
        isAuthenticated={false}
        clubName="Alpine Club"
        navLinks={[
          { href: "/", label: "Home" },
          { href: "/about", label: "About" },
        ]}
        bookingsHref="/login?next=/book"
        dashboardHref="/login"
      />,
    );

    await waitFor(() => expect(details.open).toBe(false));
  });
});
