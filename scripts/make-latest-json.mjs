// Usage: node scripts/make-latest-json.mjs <version> <sig-file> <download-url> [notes]
import { readFileSync } from "node:fs";
const [version, sigFile, url, notes = ""] = process.argv.slice(2);
if (!version || !sigFile || !url) { console.error("args: <version> <sig-file> <download-url> [notes]"); process.exit(1); }
const signature = readFileSync(sigFile, "utf8").trim();
process.stdout.write(JSON.stringify({
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": { signature, url } },
}, null, 2) + "\n");
