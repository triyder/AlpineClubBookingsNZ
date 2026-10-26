// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWizardCursor } from "../use-integration-wizard";

// ---------------------------------------------------------------------------
// Cursor writes reach the server in the order they were made (#4014).
//
// The Xero wizard browser scenario failed both retries of E2E run 37830486574
// on its "Connected to <Org>" assertion because the page came back from OAuth
// resumed on Credentials, not Connect. The captured trace showed why, in server
// timestamps: the shell saved "credentials" and then "connect" as two
// independent fire-and-forget POSTs, the browser held both in its saturated
// per-host socket queue, and the server committed "credentials" AFTER
// "connect". The stored row is last-commit-wins, so the older position won.
//
// `reorderingServer` below is that server: it holds every request it receives
// and, when drained, commits the NEWEST pending one first. Two writes on the
// wire at once therefore always land in the wrong order, deterministically, so
// these tests fail on the old hook every run rather than under CI load.
// ---------------------------------------------------------------------------

interface Pending {
  body: { currentStepId: string; completedStepIds: string[] };
  settle: () => void;
  fail: () => void;
}

function reorderingServer() {
  const pending: Pending[] = [];
  const sent: string[] = [];
  const keepalive: boolean[] = [];
  let row: string | null = null;
  let failNext = false;

  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return {
          ok: true,
          json: async () => ({ wizardId: "xero", progress: null }),
        } as Response;
      }
      const body = JSON.parse(String(init?.body)) as Pending["body"];
      sent.push(body.currentStepId);
      keepalive.push(init?.keepalive === true);
      return new Promise<Response>((resolve, reject) => {
        pending.push({
          body,
          settle: () => {
            row = body.currentStepId;
            resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
          },
          fail: () => reject(new TypeError("Failed to fetch")),
        });
      });
    },
  );

  return {
    fetchMock,
    sent,
    keepalive,
    get row() {
      return row;
    },
    get inFlight() {
      return pending.length;
    },
    /** The next request this server answers is a network failure. */
    failNextAnswer() {
      failNext = true;
    },
    /**
     * Answer everything, newest pending request first, until nothing is
     * pending — including writes the hook only sends once an earlier one
     * settles.
     */
    async drain() {
      for (let guard = 0; guard < 20; guard += 1) {
        const next = pending.pop();
        if (!next) return;
        await act(async () => {
          if (failNext) {
            failNext = false;
            next.fail();
          } else {
            next.settle();
          }
          // Let the hook's settle handler run and send whatever was waiting.
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error("drain did not settle: the hook kept sending writes");
    },
  };
}

let server: ReturnType<typeof reorderingServer>;

beforeEach(() => {
  server = reorderingServer();
  global.fetch = server.fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadedCursor() {
  const hook = renderHook(() => useWizardCursor("xero"));
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
}

describe("useWizardCursor write ordering (#4014)", () => {
  it("never lets an older step overwrite a newer one, whatever order the server answers in", async () => {
    const { result } = await loadedCursor();

    // The E2E sequence: Continue on create-app, then Continue on credentials,
    // before the first save has come back.
    act(() => {
      result.current.persist("credentials", []);
      result.current.persist("connect", []);
    });
    const onTheWireAtOnce = server.inFlight;

    await server.drain();

    // The defect itself: the operator's latest position is what is stored.
    expect(server.row).toBe("connect");
    // And why it holds: the second write waited for the first.
    expect(onTheWireAtOnce).toBe(1);
    expect(server.sent).toEqual(["credentials", "connect"]);
  });

  it("sends only the newest of several waiting writes", async () => {
    const { result } = await loadedCursor();

    act(() => {
      result.current.persist("credentials", []);
      result.current.persist("connect", []);
      result.current.persist("webhooks", []);
    });
    await server.drain();

    // "connect" was superseded while it waited, so it never went out at all.
    expect(server.sent).toEqual(["credentials", "webhooks"]);
    expect(server.row).toBe("webhooks");
  });

  it("still sends the waiting write when the earlier one fails", async () => {
    const { result } = await loadedCursor();

    act(() => {
      result.current.persist("credentials", []);
      result.current.persist("connect", []);
    });
    server.failNextAnswer();
    await server.drain();

    expect(server.sent).toEqual(["credentials", "connect"]);
    expect(server.row).toBe("connect");
  });

  it("sends a waiting write as it leaves the page, so the newest position is not lost", async () => {
    const { result } = await loadedCursor();

    // Continue onto Connect, then straight off to OAuth: the page goes away
    // while "credentials" is still in flight and "connect" is waiting for it.
    act(() => {
      result.current.persist("credentials", []);
      result.current.persist("connect", []);
    });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    // Sent at once, as a request that outlives the page; the in-flight write
    // keeps its ordinary lifetime.
    expect(server.sent).toEqual(["credentials", "connect"]);
    expect(server.keepalive).toEqual([true, true]);

    // Nothing is left waiting, so the earlier write settling sends nothing more.
    // (The stored row is not asserted: a real browser aborts the in-flight
    // request when the document goes away, which this server does not model.)
    await server.drain();
    expect(server.sent).toEqual(["credentials", "connect"]);
  });

  it("sends nothing extra on leaving when no write is waiting", async () => {
    const { result } = await loadedCursor();

    act(() => result.current.persist("connect", []));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await server.drain();

    expect(server.sent).toEqual(["connect"]);
    expect(server.keepalive).toEqual([true]);
  });

  it("sends a write at once when nothing is in flight", async () => {
    const { result } = await loadedCursor();

    act(() => result.current.persist("credentials", []));
    await server.drain();
    act(() => result.current.persist("connect", ["webhooks"]));

    expect(server.inFlight).toBe(1);
    expect(server.sent).toEqual(["credentials", "connect"]);
    await server.drain();
    expect(server.row).toBe("connect");
  });

  it("still skips a write that repeats the last one", async () => {
    const { result } = await loadedCursor();

    act(() => {
      result.current.persist("connect", ["webhooks"]);
      result.current.persist("connect", ["webhooks"]);
    });
    await server.drain();

    expect(server.sent).toEqual(["connect"]);
  });
});
