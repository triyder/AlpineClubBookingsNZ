// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}));
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
  LodgeSelect: () => null,
  initialLodgeIdFromLocation: () => null,
}));

import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";

const ROOMS_PAYLOAD = {
  rooms: [],
  capacity: {
    capacity: 0,
    source: "club_config" as const,
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 0,
  },
  canImportFromConfig: false,
  configBeds: [],
};

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function stubFetch(status = 200, body: unknown = ROOMS_PAYLOAD) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoomsBedsManager — permission-aware bookings-area gating (#1598)", () => {
  it("renders the manager when the viewer has bookings access", async () => {
    stubFetch();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Rooms & Beds")).toBeTruthy();
    });
  });

  it("renders nothing (no fetch) for a lodge viewer without bookings access", async () => {
    const { calls } = stubFetch();
    const { container } = render(
      <RoomsBedsManager permissionMatrix={matrix({ lodge: "edit" })} />,
    );

    // No async load to await; the gate short-circuits synchronously.
    await waitFor(() => {
      expect(calls).toHaveLength(0);
    });
    expect(screen.queryByText("Rooms & Beds")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing quietly on a 403 from the bed-allocation load (no toast)", async () => {
    const sonner = await import("sonner");
    stubFetch(403, { error: "Forbidden" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Rooms & Beds")).toBeNull();
    });
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("does NOT quiet-hide on a genuine 500 — keeps the shell and toasts the failure", async () => {
    const sonner = await import("sonner");
    stubFetch(500, { error: "Boom" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    // A 5xx is a real failure, not a permission denial: the manager stays
    // mounted (heading visible) and surfaces the error via toast.
    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    expect(screen.getByText("Rooms & Beds")).toBeTruthy();
  });
});

interface SeedBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface SeedRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: SeedBed[];
}

// A method/URL-aware, stateful fetch stub. PATCH/DELETE mutate an in-memory
// store; the follow-up GET reflects those writes, so a saved row re-syncs to
// server state while every other row's server value is unchanged — exactly the
// shape needed to observe that a sibling's unsaved draft survived a save.
function stubStatefulFetch(seed: SeedRoom[]) {
  let rooms: SeedRoom[] = seed.map((room) => ({
    ...room,
    beds: room.beds.map((bed) => ({ ...bed })),
  }));
  const calls: Array<{ url: string; method: string }> = [];
  // One-shot gate: when set, the next list GET (a post-save refetch) blocks on
  // this promise, letting a test hold the refetch "in flight" while it types.
  let refetchGate: Promise<void> | null = null;

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  // Mirror the real PATCH handlers, which `.trim()` the name server-side. This
  // is what makes the re-sync path load-bearing: a draft with surrounding
  // whitespace differs from the saved value until the saved row re-syncs.
  const normalize = <T extends { name?: string }>(patch: T): T =>
    typeof patch.name === "string" ? { ...patch, name: patch.name.trim() } : patch;

  const fetchMock = vi.fn(
    async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });

      const bedMatch = url.match(/\/bed-allocation\/beds\/([^/?]+)$/);
      if (bedMatch) {
        const id = bedMatch[1];
        if (method === "PATCH") {
          const patch = normalize(JSON.parse(init?.body ?? "{}") as Partial<SeedBed>);
          rooms = rooms.map((room) => ({
            ...room,
            beds: room.beds.map((bed) =>
              bed.id === id ? { ...bed, ...patch } : bed,
            ),
          }));
          const bed = rooms.flatMap((room) => room.beds).find((b) => b.id === id);
          return respond(200, { bed });
        }
        if (method === "DELETE") {
          const bed = rooms.flatMap((room) => room.beds).find((b) => b.id === id);
          rooms = rooms.map((room) => ({
            ...room,
            beds: room.beds.filter((b) => b.id !== id),
          }));
          return respond(200, { bed });
        }
      }

      const roomMatch = url.match(/\/bed-allocation\/rooms\/([^/?]+)$/);
      if (roomMatch && method === "PATCH") {
        const id = roomMatch[1];
        const patch = normalize(JSON.parse(init?.body ?? "{}") as Partial<SeedRoom>);
        rooms = rooms.map((room) =>
          room.id === id ? { ...room, ...patch } : room,
        );
        const room = rooms.find((r) => r.id === id);
        return respond(200, { room });
      }

      if (url.includes("/bed-allocation/rooms")) {
        if (refetchGate) {
          const gate = refetchGate;
          refetchGate = null; // one-shot
          await gate;
        }
        return respond(200, {
          rooms,
          capacity: {
            capacity: 0,
            source: "club_config" as const,
            bedAllocationEnabled: false,
            activeBedCount: 0,
            fallbackCapacity: 0,
          },
          canImportFromConfig: false,
          configBeds: [],
        });
      }

      return respond(404, { error: "unhandled" });
    },
  ) as unknown as typeof fetch;

  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    // Simulate a concurrent server-side deletion (a row that vanishes on the
    // next GET without going through this client's Delete button).
    deleteBedServerSide(id: string) {
      rooms = rooms.map((room) => ({
        ...room,
        beds: room.beds.filter((bed) => bed.id !== id),
      }));
    },
    // Hold the next post-save refetch open; returns a release() that lets it
    // complete. Used to drive a mid-flight edit against the in-flight save.
    gateNextRefetch() {
      let release!: () => void;
      refetchGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function seedRoom(overrides: Partial<SeedRoom> & { id: string }): SeedRoom {
  return {
    name: overrides.id,
    sortOrder: 0,
    active: true,
    notes: null,
    beds: [],
    ...overrides,
  };
}

function seedBed(overrides: Partial<SeedBed> & { id: string; roomId: string }): SeedBed {
  return {
    name: overrides.id,
    sortOrder: 0,
    active: true,
    ...overrides,
  };
}

const editorMatrix = () => matrix({ lodge: "edit", bookings: "edit" });

function rowOf(displayValue: string): HTMLElement {
  const input = screen.getByDisplayValue(displayValue);
  const row = input.closest("tr");
  if (!row) throw new Error(`No table row for input "${displayValue}"`);
  return row as HTMLElement;
}

describe("RoomsBedsManager — a save preserves other unsaved drafts (#1673)", () => {
  it("saving bed A keeps bed B's unsaved draft and re-syncs bed A", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" }),
          seedBed({ id: "bed-b", roomId: "room-1", name: "Bed B" }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed B"), {
      target: { value: "Bed B edited" },
    });

    // Both rows are now dirty.
    expect(screen.getAllByText("Unsaved")).toHaveLength(2);

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    // After the save + refetch: bed B's draft is untouched, bed A reflects the
    // saved value, and only bed B still reads as unsaved.
    await waitFor(() => {
      expect(screen.getAllByText("Unsaved")).toHaveLength(1);
    });
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    expect(screen.getByDisplayValue("Bed B edited")).toBeTruthy();
    // The surviving "Unsaved" badge belongs to bed B.
    expect(within(rowOf("Bed B edited")).getByText("Unsaved")).toBeTruthy();
    expect(within(rowOf("Bed A edited")).queryByText("Unsaved")).toBeNull();
  });

  it("saving a bed in one room keeps an unsaved room-name draft in another room", async () => {
    stubStatefulFetch([
      seedRoom({ id: "room-1", name: "Room 1" }),
      seedRoom({
        id: "room-2",
        name: "Room 2",
        beds: [seedBed({ id: "bed-x", roomId: "room-2", name: "Bed X" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed X");

    fireEvent.change(screen.getByDisplayValue("Room 1"), {
      target: { value: "Room 1 edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed X"), {
      target: { value: "Bed X edited" },
    });

    fireEvent.click(within(rowOf("Bed X edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed X edited")).toBeTruthy();
    });
    // The room-name draft in the untouched room survived the sibling save.
    expect(screen.getByDisplayValue("Room 1 edited")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("shows the Unsaved badge on edit and clears it after a successful save", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");
    expect(screen.queryByText("Unsaved")).toBeNull();

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
  });

  it("drops a stale draft for a bed deleted server-side, keeping a sibling's draft", async () => {
    const server = stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" }),
          seedBed({ id: "bed-b", roomId: "room-1", name: "Bed B" }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed B"), {
      target: { value: "Bed B edited" },
    });

    // Bed B disappears server-side, then a plain refresh re-fetches.
    server.deleteBedServerSide("bed-b");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Bed B edited")).toBeNull();
    });
    // Bed A's unsaved draft survives the refresh; only its badge remains.
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    expect(screen.getAllByText("Unsaved")).toHaveLength(1);
  });

  it("re-syncs the just-saved row to the normalized server value, clearing its badge", async () => {
    // Discriminates the re-sync path: the draft ("Bed A " with a trailing
    // space) differs from the trimmed server value, so without re-syncing the
    // saved row its "Unsaved" badge would never clear.
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A " },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    // getByDisplayValue trims for matching, so "Bed A" still locates the row.
    const row = rowOf("Bed A");
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    // The saved row now holds the trimmed value, not the raw draft.
    const nameInput = within(rowOf("Bed A")).getByRole(
      "textbox",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Bed A");
  });

  it("re-syncs a just-saved room to the normalized server value, clearing its badge", async () => {
    // Mirror of the bed re-sync test, but through saveRoom -> mergeRoomEdits.
    // Seed a bedless room so the only "Save" button is the room's.
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.change(screen.getByDisplayValue("Room 1"), {
      target: { value: "Room 1 " },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    // getByDisplayValue trims for matching; assert the raw value is trimmed.
    const nameInput = screen.getByDisplayValue("Room 1") as HTMLInputElement;
    expect(nameInput.value).toBe("Room 1");
  });

  it("keeps a mid-flight edit to the just-saved row instead of clobbering it", async () => {
    const server = stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A v1" },
    });

    // Save "v1", but hold the refetch open so the row is still "in flight".
    const saveButton = within(rowOf("Bed A v1")).getByRole("button", {
      name: "Save",
    });
    const releaseRefetch = server.gateNextRefetch();
    fireEvent.click(saveButton);

    // The input stays editable during the save: the admin types "v2".
    fireEvent.change(screen.getByDisplayValue("Bed A v1"), {
      target: { value: "Bed A v2" },
    });

    // Let the (stale-for-v2) refetch land; the newer draft must NOT be clobbered.
    await act(async () => {
      releaseRefetch();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed A v2")).toBeTruthy();
    });
    // The mid-flight edit is newer than what was saved, so it stays unsaved.
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("keeps the room/bed add-form drafts across a sibling save", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByPlaceholderText("Room name"), {
      target: { value: "New room draft" },
    });
    fireEvent.change(screen.getByPlaceholderText("Bed name"), {
      target: { value: "New bed draft" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    });
    // The add-forms are independent of the refetch and keep their text.
    expect(screen.getByDisplayValue("New room draft")).toBeTruthy();
    expect(screen.getByDisplayValue("New bed draft")).toBeTruthy();
  });

  it("keeps the Add Bed draft when the create request fails", async () => {
    const sonner = await import("sonner");
    // The stub returns 404 for POST /beds (no matching handler), so the create
    // fails and the draft must survive rather than being wiped.
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.change(screen.getByPlaceholderText("Bed name"), {
      target: { value: "Draft bed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Bed" }));

    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    // Failed create leaves the typed value in place.
    expect(screen.getByDisplayValue("Draft bed")).toBeTruthy();
  });
});
