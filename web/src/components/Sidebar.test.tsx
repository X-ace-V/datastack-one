// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar, type SidebarProps } from "./Sidebar";
import type { SessionSummary } from "../store/sessionStore";

const SESSIONS: SessionSummary[] = [
  {
    id: "ses_1",
    title: "Loan review",
    model: "opencode/big-pickle",
    createdAt: "2026-07-17T10:00:00Z",
    updatedAt: "2026-07-17T10:00:00Z",
    status: "working",
  },
  {
    id: "ses_2",
    title: "Branch report",
    model: null,
    createdAt: "2026-07-16T09:00:00Z",
    updatedAt: "2026-07-16T09:00:00Z",
    status: "waiting_approval",
  },
  {
    id: "ses_3",
    title: "Warehouse setup",
    model: null,
    createdAt: "2026-07-16T09:00:00Z",
    updatedAt: "2026-07-16T09:00:00Z",
    status: "waiting_input",
  },
];

function props(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    activeSessionId: null,
    onSelectSession: () => {},
    sessions: SESSIONS,
    onCreateSession: async () => ({ id: "ses_new" }),
    onRenameSession: async () => {},
    onDeleteSession: async () => {},
    ...overrides,
  };
}

describe("Sidebar", () => {
  afterEach(cleanup);

  it("renders the central index with background status on inactive sessions", () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByText("Loan review")).toBeTruthy();
    expect(screen.getByText("Branch report")).toBeTruthy();
    expect(screen.getByLabelText("Working")).toBeTruthy();
    expect(screen.getByLabelText("Waiting for approval")).toBeTruthy();
    expect(screen.getByLabelText("Waiting for input")).toBeTruthy();
  });

  it("renders loading, empty, and load-error states honestly", () => {
    const { rerender } = render(<Sidebar {...props({ sessions: [], loading: true })} />);
    expect(screen.getByText(/loading sessions/i)).toBeTruthy();
    rerender(<Sidebar {...props({ sessions: [] })} />);
    expect(screen.getByText(/no sessions yet/i)).toBeTruthy();
    rerender(<Sidebar {...props({ sessions: [], loadError: "runtime unavailable" })} />);
    expect(screen.getByRole("alert").textContent).toContain("runtime unavailable");
  });

  it("creates and selects a new OpenCode session", async () => {
    const onCreateSession = vi.fn(async () => ({ id: "ses_new" }));
    const onSelectSession = vi.fn();
    render(<Sidebar {...props({ sessions: [], onCreateSession, onSelectSession })} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /new session/i })));
    expect(onCreateSession).toHaveBeenCalledOnce();
    expect(onSelectSession).toHaveBeenCalledWith("ses_new");
  });

  it("switches the active session without cancelling another one", () => {
    const onSelectSession = vi.fn();
    render(<Sidebar {...props({ activeSessionId: "ses_1", onSelectSession })} />);
    expect(screen.getByRole("button", { name: "Loan review" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Branch report" }));
    expect(onSelectSession).toHaveBeenCalledWith("ses_2");
  });

  it("renames through the central session registry", async () => {
    const onRenameSession = vi.fn(async () => {});
    render(<Sidebar {...props({ onRenameSession })} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Loan review" }));
    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Overdue analysis" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(onRenameSession).toHaveBeenCalledWith("ses_1", "Overdue analysis");
  });

  it("deletes after confirmation and selects the next session", async () => {
    const onDeleteSession = vi.fn(async () => {});
    const onSelectSession = vi.fn();
    render(<Sidebar {...props({ activeSessionId: "ses_1", onDeleteSession, onSelectSession })} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Loan review" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm delete Loan review" })));
    expect(onDeleteSession).toHaveBeenCalledWith("ses_1");
    expect(onSelectSession).toHaveBeenCalledWith("ses_2");
  });

  it("keeps row controls scoped to their own session", () => {
    render(<Sidebar {...props()} />);
    const [first, second] = screen.getAllByRole("listitem") as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("button", { name: "Rename Loan review" })).toBeTruthy();
    expect(within(second).getByRole("button", { name: "Delete Branch report" })).toBeTruthy();
  });

  it("opens database connection settings without moving them into the composer", () => {
    const onOpenSettings = vi.fn();
    render(<Sidebar {...props({ onOpenSettings })} />);
    fireEvent.click(screen.getByRole("button", { name: /settings . connections/i }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
