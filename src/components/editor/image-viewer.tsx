import { useEffect, useRef, useState } from "react";
import { readImageBase64 } from "@/lib/fs";
import { imageMimeFor } from "@/lib/image";

interface ImageViewerProps {
  path: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "loaded"; src: string; width: number; height: number }
  | { status: "too_large" }
  | { status: "error"; message: string };

export function ImageViewer({ path }: ImageViewerProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setState({ status: "loading" });
    let cancelled = false;

    readImageBase64(path)
      .then((b64) => {
        if (cancelled) return;
        const mime = imageMimeFor(path);
        const src = `data:${mime};base64,${b64}`;
        setState({ status: "loaded", src, width: 0, height: 0 });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = typeof e === "string" ? e : String(e);
        if (msg === "too_large") {
          setState({ status: "too_large" });
        } else {
          setState({ status: "error", message: msg });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  const filename = path.split("/").at(-1) ?? path;

  return (
    <div className="flex h-full flex-col bg-muted/30">
      {/* Image display area */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}
        {state.status === "too_large" && (
          <div className="text-center">
            <p className="text-muted-foreground text-sm">
              Image is larger than 25 MB — cannot display it here.
            </p>
          </div>
        )}
        {state.status === "error" && (
          <div className="text-center">
            <p className="text-destructive text-sm">
              Failed to load image: {state.message}
            </p>
          </div>
        )}
        {state.status === "loaded" && (
          /* Checkerboard pattern to reveal transparency */
          <div
            className="flex max-h-full max-w-full items-center justify-center overflow-hidden rounded"
            style={{
              backgroundImage:
                "linear-gradient(45deg, #ccc 25%, transparent 25%), " +
                "linear-gradient(-45deg, #ccc 25%, transparent 25%), " +
                "linear-gradient(45deg, transparent 75%, #ccc 75%), " +
                "linear-gradient(-45deg, transparent 75%, #ccc 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
              backgroundColor: "#e0e0e0",
            }}
          >
            <img
              ref={imgRef}
              src={state.src}
              alt={filename}
              className="max-h-full max-w-full object-contain"
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setState((prev) =>
                  prev.status === "loaded"
                    ? {
                        ...prev,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                      }
                    : prev,
                );
              }}
            />
          </div>
        )}
      </div>

      {/* Footer info bar */}
      <div className="border-t px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-3 shrink-0">
        <span className="font-medium">{filename}</span>
        {state.status === "loaded" && state.width > 0 && state.height > 0 && (
          <span>
            {state.width} × {state.height}
          </span>
        )}
        {state.status === "loading" && <span>Loading…</span>}
      </div>
    </div>
  );
}
