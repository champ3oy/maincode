// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";

const install = vi.fn();
vi.mock("@/hooks/use-update-check", () => ({ useUpdateCheck: vi.fn() }));
import { useUpdateCheck } from "@/hooks/use-update-check";
import { UpdateIndicator } from "./update-indicator";

afterEach(cleanup);

describe("UpdateIndicator", () => {
  it("renders nothing when idle", () => {
    vi.mocked(useUpdateCheck).mockReturnValue({ status: "idle", install } as any);
    const { container } = render(<UpdateIndicator />);
    expect(container.textContent).toBe("");
  });

  it("shows a pill when available and installs on click", async () => {
    vi.mocked(useUpdateCheck).mockReturnValue({
      status: "available",
      version: "0.1.3",
      notes: "n",
      install,
    } as any);
    render(<UpdateIndicator />);

    fireEvent.click(screen.getByRole("button", { name: /update available/i }));

    const installButton = await waitFor(() =>
      screen.getByRole("button", { name: /update & restart/i }),
    );
    fireEvent.click(installButton);

    expect(install).toHaveBeenCalled();
  });

  it("shows download progress when downloading", async () => {
    vi.mocked(useUpdateCheck).mockReturnValue({
      status: "downloading",
      version: "0.1.3",
      progress: 42,
      install,
    } as any);
    render(<UpdateIndicator />);

    fireEvent.click(screen.getByRole("button", { name: /update available/i }));

    await waitFor(() => screen.getByText(/downloading/i));
    expect(screen.getByText(/42%/)).toBeTruthy();
  });

  it("shows an error message when the update failed", async () => {
    vi.mocked(useUpdateCheck).mockReturnValue({
      status: "error",
      version: "0.1.3",
      install,
    } as any);
    render(<UpdateIndicator />);

    fireEvent.click(screen.getByRole("button", { name: /update available/i }));

    await waitFor(() => screen.getByText(/update failed/i));
  });
});
