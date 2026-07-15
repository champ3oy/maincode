// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TerminalTabs } from "./terminal-tabs";

const tabs = [{ id: 0, title: "zsh" }, { id: 1, title: "claude" }];

afterEach(cleanup);

describe("TerminalTabs", () => {
  it("renders a chip per tab and marks the active one", () => {
    render(<TerminalTabs tabs={tabs} activeId={1} onActivate={() => {}} onClose={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("zsh")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /claude/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("calls onActivate / onClose / onAdd", () => {
    const onActivate = vi.fn(), onClose = vi.fn(), onAdd = vi.fn();
    render(<TerminalTabs tabs={tabs} activeId={0} onActivate={onActivate} onClose={onClose} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("tab", { name: /claude/ }));
    expect(onActivate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByLabelText("Close zsh"));
    expect(onClose).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByLabelText("New terminal"));
    expect(onAdd).toHaveBeenCalled();
  });
});
