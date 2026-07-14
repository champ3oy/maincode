// Downloads a platform Node runtime and installs typescript-language-server +
// a pinned typescript into resources/lsp/ so they can be bundled as Tauri
// resources. Idempotent: skips work if the outputs already exist.
import { existsSync, mkdirSync, rmSync, cpSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NODE_VERSION = "v22.22.1";
const TLS_VERSION = "5.3.0";
const TS_VERSION = "5.9.2";
const PYRIGHT_VERSION = "1.1.411";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources", "lsp");
const serverDir = join(out, "server");
const nodeBin = join(out, "node");

function plat() {
  const p = platform();
  if (p === "darwin") return { os: "darwin", ext: "tar.gz" };
  if (p === "linux") return { os: "linux", ext: "tar.gz" };
  if (p === "win32") return { os: "win", ext: "zip" };
  throw new Error(`unsupported platform ${p}`);
}
function cpu() {
  const a = arch();
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  throw new Error(`unsupported arch ${a}`);
}

function fetchNode() {
  if (existsSync(nodeBin)) return;
  const { os, ext } = plat();
  const name = `node-${NODE_VERSION}-${os}-${cpu()}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${ext}`;
  const tmp = join(out, "node-dl");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log(`downloading ${url}`);
  execSync(`curl -fsSL ${url} | tar -xz -C ${tmp}`, { stdio: "inherit" });
  cpSync(join(tmp, name, "bin", "node"), nodeBin);
  chmodSync(nodeBin, 0o755);
  rmSync(tmp, { recursive: true, force: true });
}

function installServer() {
  const cli = join(serverDir, "node_modules", "typescript-language-server", "lib", "cli.mjs");
  const pyright = join(serverDir, "node_modules", "pyright", "langserver.index.js");
  if (existsSync(cli) && existsSync(pyright)) return;
  mkdirSync(serverDir, { recursive: true });
  execSync(
    `npm init -y && npm install --omit=dev typescript-language-server@${TLS_VERSION} typescript@${TS_VERSION} pyright@${PYRIGHT_VERSION}`,
    { cwd: serverDir, stdio: "inherit" },
  );
}

mkdirSync(out, { recursive: true });
fetchNode();
installServer();
console.log("LSP sidecar ready at resources/lsp/");
