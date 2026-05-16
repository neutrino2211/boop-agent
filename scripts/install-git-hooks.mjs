#!/usr/bin/env node
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

execSync("git config core.hooksPath .githooks", {
  cwd: root,
  stdio: "inherit",
});

console.log("Installed git hooks path: .githooks");
