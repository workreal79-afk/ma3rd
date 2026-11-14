#!/usr/bin/env node
// يبني حزمة اختبار الواجهة (JSX → ESM) ثم يشغّلها عبر node --test.
// السبب: Node لا يستطيع استيراد .jsx مباشرة، والاختبار يحتاج بيئة DOM (jsdom).
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(here, "..");
const esbuild = path.join(clientRoot, "node_modules", ".bin", "esbuild");
const outFile = path.join(here, ".build", "ui.test.mjs");

fs.mkdirSync(path.dirname(outFile), { recursive: true });

if (!fs.existsSync(esbuild)) {
  console.error("esbuild غير مثبّت — نفّذ: npm --prefix client install");
  process.exit(1);
}

const build = spawnSync(esbuild, [
  path.join(here, "ui.test.jsx"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--packages=external",
  "--jsx=automatic",
  "--loader:.css=empty",
  "--define:import.meta.env={}",
  `--outfile=${outFile}`,
], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", outFile], { stdio: "inherit" });
process.exit(run.status ?? 1);
