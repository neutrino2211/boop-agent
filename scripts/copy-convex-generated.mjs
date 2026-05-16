#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "convex", "_generated");
const destination = resolve(root, "dist", "convex", "_generated");

if (!existsSync(source)) {
  console.error("[build] convex/_generated is missing. Run `npm run deploy:convex` first.");
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(resolve(destination, ".."), { recursive: true });
cpSync(source, destination, { recursive: true });

console.log("[build] copied convex/_generated into dist/convex/_generated");
