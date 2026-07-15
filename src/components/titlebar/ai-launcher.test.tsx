// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { AiLauncher } from "./ai-launcher";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

afterEach(cleanup);
beforeEach(() => vi.mocked(invoke).mockReset());

describe("AiLauncher", () => {
  it("lists detected CLIs and launches the picked one", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { id: "claude", label: "Claude Code", bin: "claude" },
      { id: "agy", label: "Antigravity", bin: "agy" },
    ]);
    const onLaunch = vi.fn();
    render(<AiLauncher onLaunch={onLaunch} />);

    fireEvent.click(screen.getByLabelText("AI CLIs"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_ai_clis"));
    await waitFor(() => screen.getByText("Claude Code"));

    fireEvent.click(screen.getByText("Antigravity"));
    expect(onLaunch).toHaveBeenCalledWith({
      id: "agy",
      label: "Antigravity",
      bin: "agy",
    });
  });

  it("shows an empty state when none are installed", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<AiLauncher onLaunch={() => {}} />);

    fireEvent.click(screen.getByLabelText("AI CLIs"));

    await waitFor(() => screen.getByText(/No AI CLIs found/));
  });
});
