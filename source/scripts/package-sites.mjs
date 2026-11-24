import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, ".sites-package");
const archive = resolve(root, "zsyh-vinext-sites.tar.gz");

await rm(staging, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(resolve(staging, ".openai"), { recursive: true });
await cp(resolve(root, "dist"), resolve(staging, "dist"), { recursive: true });
await cp(
  resolve(root, ".openai/hosting.json"),
  resolve(staging, ".openai/hosting.json"),
);

const sitesConfig = await readFile(
  resolve(root, "wrangler.sites.jsonc"),
  "utf8",
);
await writeFile(resolve(staging, "wrangler.jsonc"), sitesConfig);

const tar = spawnSync("tar", ["-czf", archive, "-C", staging, "."], {
  stdio: "inherit",
});

if (tar.status !== 0) {
  throw new Error(`tar failed with exit code ${tar.status ?? "unknown"}`);
}

console.log(archive);
