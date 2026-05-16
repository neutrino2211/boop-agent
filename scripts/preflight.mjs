#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const generated = resolve(here, "..", "convex", "_generated", "api.js");

if (!existsSync(generated)) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run one of these before pushing/deploying:                 │
│    npm run deploy:convex   (recommended)                    │
│    npx convex codegen      (types only)                     │
│                                                             │
│  Then commit convex/_generated to git.                      │
│  Cloud startup does not run convex dev automatically.       │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}
