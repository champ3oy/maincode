import React from "react";
import ReactDOM from "react-dom/client";
import { DEFAULT_THEMES } from "@pierre/diffs";
import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { ThemeProvider } from "next-themes";
import { listen } from "@tauri-apps/api/event";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import App from "./App";
import "./App.css";
import { perfLog } from "@/lib/perf";
import { DiffSettingsProvider } from "@/hooks/use-diff-settings";
import { RecentReposProvider } from "@/hooks/use-recent-repos";
import { CommitDetailsCacheProvider } from "@/hooks/use-commit-details-cache";

const diffWorkerPoolSize = Math.min(
  Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1),
  3,
);

const poolOptions: WorkerPoolOptions = {
  poolSize: diffWorkerPoolSize,
  totalASTLRUCacheSize: 100,
  workerFactory: () => new DiffsWorker(),
};

// Preload the default theme + a broad set of common languages so the first
// file a user opens is highlighted from cache instead of paying a per-worker
// shiki initialization cost.
const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-wasm",
  langs: [
    "tsx",
    "typescript",
    "javascript",
    "jsx",
    "json",
    "yaml",
    "toml",
    "rust",
    "go",
    "python",
    "ruby",
    "css",
    "scss",
    "html",
    "svelte",
    "vue",
    "sh",
    "bash",
    "fish",
    "md",
    "mdx",
    "sql",
  ],
};

// ---- perf instrumentation boot ------------------------------------------
// One-time environment facts: lets us correlate logs across reopens.
perfLog("boot", "env", {
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: (navigator as unknown as { deviceMemory?: number })
    .deviceMemory,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  mode: import.meta.env.MODE,
  diffWorkerPoolSize,
});

// Mirror backend perf:log events into the web console so a single copy/paste
// captures both layers.
void listen<Record<string, unknown>>("perf:log", (event) => {
  const payload = event.payload ?? {};
  const { op, ...rest } = payload as { op?: string } & Record<string, unknown>;
  perfLog("rust", op ?? "event", rest);
});
// -------------------------------------------------------------------------

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <ThemeProvider attribute="class" defaultTheme="system">
        <DiffSettingsProvider>
          <RecentReposProvider>
            <CommitDetailsCacheProvider>
              <App />
            </CommitDetailsCacheProvider>
          </RecentReposProvider>
        </DiffSettingsProvider>
      </ThemeProvider>
    </WorkerPoolContextProvider>
  </React.StrictMode>,
);
