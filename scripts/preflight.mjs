#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const generated = resolve(here, "..", "convex", "_generated", "api.js");

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function generateConvexTypes() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["convex", "dev", "--once", "--typecheck", "disable", "--tail-logs", "disable"];
  console.log(
    "\n[preflight] convex/_generated is missing. Attempting non-interactive generation:",
  );
  console.log(`[preflight]   npx ${args.join(" ")}\n`);

  const result = spawnSync(npx, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`[preflight] Failed to run npx: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[preflight] Convex type generation exited with code ${result.status}.`);
    return false;
  }
  return true;
}

if (!existsSync(generated)) {
  const autoSetup = isTruthy(process.env.BOOP_AUTO_CONVEX_SETUP);
  if (autoSetup) generateConvexTypes();
}

if (!existsSync(generated)) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run one of these first:                                    │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
│                                                             │
│  For cloud startup, you can set:                            │
│    BOOP_AUTO_CONVEX_SETUP=true                              │
│    CONVEX_DEPLOY_KEY=... (and/or CONVEX_DEPLOYMENT)         │
│                                                             │
│  All options write convex/_generated/ which server needs.   │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}
