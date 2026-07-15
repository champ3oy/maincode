// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TerminalDock } from "./terminal-dock";

vi.mock("./terminal-panel", () => ({
  TerminalPanel: ({ active }: { active: boolean }) => (
    <div data-testid="panel" data-active={active} />
  ),
}));

afterEach(cleanup);

describe("TerminalDock tabs", () => {
  it("starts with one active terminal; + adds and activates a new one", () => {
    render(<TerminalDock cwd="/x" position="bottom" onTogglePosition={() => {}} onEmpty={() => {}} />);
    expect(screen.getAllByTestId("panel")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("New terminal"));
    const panels = screen.getAllByTestId("panel");
    expect(panels).toHaveLength(2);
    // exactly one active
    expect(panels.filter((p) => p.getAttribute("data-active") === "true")).toHaveLength(1);
  });
  it("closing the last terminal calls onEmpty", () => {
    const onEmpty = vi.fn();
    render(<TerminalDock cwd="/x" position="bottom" onTogglePosition={() => {}} onEmpty={onEmpty} />);
    fireEvent.click(screen.getByLabelText(/Close/));
    expect(onEmpty).toHaveBeenCalled();
  });
});
