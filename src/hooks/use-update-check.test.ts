// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdateCheck } from "./use-update-check";

beforeEach(() => {
  vi.mocked(check).mockReset();
  vi.mocked(relaunch).mockReset();
});

describe("useUpdateCheck", () => {
  it("stays idle when no update", async () => {
    vi.mocked(check).mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });
  it("reports available, then installs + relaunches", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: "0.1.3", body: "notes", downloadAndInstall } as any);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("available"));
    expect(result.current.version).toBe("0.1.3");
    await act(async () => {
      await result.current.install();
    });
    expect(downloadAndInstall).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalled();
  });
  it("swallows check errors to idle", async () => {
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });
});
