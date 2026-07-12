// Lightweight performance logging used across the renderer and bridged from
// the Rust backend via the `perf:log` Tauri event. Every line is prefixed with
// `[maincode-perf]` so it is easy to grep / copy out of the devtools console.
const PREFIX = "[maincode-perf]";

type PerfExtra = Record<string, unknown> | undefined;

function now(): number {
  if (typeof performance !== "undefined") return performance.now();
  return Date.now();
}

export function perfLog(
  layer: string,
  op: string,
  extra?: PerfExtra,
): void {
  if (extra && Object.keys(extra).length > 0) {
    // eslint-disable-next-line no-console
    console.log(`${PREFIX} ${layer}:${op}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${PREFIX} ${layer}:${op}`);
  }
}

export function perfLogJson(
  layer: string,
  op: string,
  extra?: PerfExtra,
): void {
  const payload = extra ?? {};
  // eslint-disable-next-line no-console
  console.log(`${PREFIX} ${layer}:${op} ${JSON.stringify(payload)}`);
}

export function perfTimed<T>(
  layer: string,
  op: string,
  fn: () => T,
  extra?: PerfExtra,
): T {
  const start = now();
  try {
    const result = fn();
    perfLog(layer, op, { ms: +(now() - start).toFixed(2), ...extra });
    return result;
  } catch (err) {
    perfLog(layer, `${op}:error`, {
      ms: +(now() - start).toFixed(2),
      error: String(err),
      ...extra,
    });
    throw err;
  }
}

export async function perfTimedAsync<T>(
  layer: string,
  op: string,
  fn: () => Promise<T>,
  extra?: PerfExtra,
): Promise<T> {
  const start = now();
  try {
    const result = await fn();
    perfLog(layer, op, { ms: +(now() - start).toFixed(2), ...extra });
    return result;
  } catch (err) {
    perfLog(layer, `${op}:error`, {
      ms: +(now() - start).toFixed(2),
      error: String(err),
      ...extra,
    });
    throw err;
  }
}

export function perfMark(): () => number {
  const start = now();
  return () => +(now() - start).toFixed(2);
}
