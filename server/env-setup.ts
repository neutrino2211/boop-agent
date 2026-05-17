// Loads .env.local (priority) then .env (fallback) from the project root.
// Imported for side effects — must run before any module reads process.env.
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rootCandidates = [resolve(here, ".."), resolve(here, "..", "..")];
const root =
  rootCandidates.find((candidate) => existsSync(resolve(candidate, "package.json"))) ??
  rootCandidates[0];

for (const name of [".env.local", ".env"]) {
  const path = resolve(root, name);
  if (existsSync(path)) config({ path });
}
