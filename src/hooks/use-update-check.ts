import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Status = "idle" | "available" | "downloading" | "error";
const SIX_HOURS = 6 * 60 * 60 * 1000;

export function useUpdateCheck() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<number | undefined>();
  const updateRef = useRef<Update | null>(null);
  const [meta, setMeta] = useState<{ version?: string; notes?: string }>({});

  const run = useCallback(async () => {
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setMeta({ version: update.version, notes: update.body });
        setStatus("available");
      }
    } catch {
      // background check: stay quiet (offline / rate-limited)
    }
  }, []);

  useEffect(() => {
    void run();
    const t = setInterval(() => void run(), SIX_HOURS);
    return () => clearInterval(t);
  }, [run]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setStatus("downloading");
    try {
      let total = 0,
        got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total) setProgress(Math.round((got / total) * 100));
        }
      });
      await relaunch();
    } catch {
      setStatus("error");
    }
  }, []);

  return { status, version: meta.version, notes: meta.notes, progress, install };
}
