// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select does not open in jsdom; a native select keeps value binding and
// onValueChange semantics testable (same shim the admin member-detail tests use).
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <select
      aria-label="After sign-in, take me to"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => <option value={value}>{children}</option>,
}));

import { PostLoginLandingPreference } from "@/app/(authenticated)/profile/post-login-landing-preference";

type FetchResult = { ok: boolean; body: unknown };

function jsonResponse({ ok, body }: FetchResult): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

/**
 * Route fetch by method: the GET on mount reads the current value + canChoose;
 * the PUT persists a change. `putResult` may be a value or a promise the test
 * controls (to assert the busy/disabled window).
 */
function stubFetch(options: {
  get: FetchResult;
  put?: FetchResult | Promise<FetchResult>;
}) {
  const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve(options.put ?? { ok: true, body: {} }).then(
        jsonResponse,
      );
    }
    return Promise.resolve(jsonResponse(options.get));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function select() {
  return screen.getByRole("combobox", {
    name: /after sign-in, take me to/i,
  }) as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostLoginLandingPreference (#2090)", () => {
  it("self-hides when the server reports canChoose:false", async () => {
    stubFetch({ get: { ok: true, body: { postLoginLanding: null, canChoose: false } } });

    const { container } = render(<PostLoginLandingPreference />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders the current value returned by the server", async () => {
    stubFetch({
      get: {
        ok: true,
        body: { postLoginLanding: "ADMIN_DASHBOARD", canChoose: true },
      },
    });

    render(<PostLoginLandingPreference />);

    await waitFor(() => expect(select().value).toBe("ADMIN_DASHBOARD"));
  });

  it("saves a change with a PUT and shows saved feedback", async () => {
    const fetchMock = stubFetch({
      get: { ok: true, body: { postLoginLanding: null, canChoose: true } },
      put: { ok: true, body: { postLoginLanding: "MEMBER_DASHBOARD", canChoose: true } },
    });

    render(<PostLoginLandingPreference />);
    await waitFor(() => expect(select()).not.toBeDisabled());

    fireEvent.change(select(), { target: { value: "MEMBER_DASHBOARD" } });

    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(select().value).toBe("MEMBER_DASHBOARD");
    expect(
      fetchMock.mock.calls.some(
        ([, init]) =>
          (init as RequestInit | undefined)?.method === "PUT" &&
          String((init as RequestInit).body).includes("MEMBER_DASHBOARD"),
      ),
    ).toBe(true);
  });

  it("rolls back and shows an error when the save fails", async () => {
    stubFetch({
      get: {
        ok: true,
        body: { postLoginLanding: "ADMIN_DASHBOARD", canChoose: true },
      },
      put: { ok: false, body: {} },
    });

    render(<PostLoginLandingPreference />);
    await waitFor(() => expect(select().value).toBe("ADMIN_DASHBOARD"));

    fireEvent.change(select(), { target: { value: "MEMBER_DASHBOARD" } });

    await waitFor(() =>
      expect(
        screen.getByText(/could not save your landing preference/i),
      ).toBeInTheDocument(),
    );
    // The optimistic value is reverted to what the server last confirmed.
    expect(select().value).toBe("ADMIN_DASHBOARD");
  });

  it("disables the control and shows a saving indicator while the PUT is in flight", async () => {
    let resolvePut: (result: FetchResult) => void = () => {};
    const putPromise = new Promise<FetchResult>((resolve) => {
      resolvePut = resolve;
    });
    stubFetch({
      get: { ok: true, body: { postLoginLanding: null, canChoose: true } },
      put: putPromise,
    });

    render(<PostLoginLandingPreference />);
    await waitFor(() => expect(select()).not.toBeDisabled());

    fireEvent.change(select(), { target: { value: "ADMIN_DASHBOARD" } });

    // Busy window: the select is disabled and the saving indicator is shown.
    await waitFor(() => expect(select()).toBeDisabled());
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    resolvePut({ ok: true, body: { postLoginLanding: "ADMIN_DASHBOARD", canChoose: true } });

    await waitFor(() => expect(select()).not.toBeDisabled());
    expect(screen.getByText("Saved.")).toBeInTheDocument();
  });
});
