import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
function jsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? jsFiles(file) : entry.name.endsWith(".js") ? [file] : [];
    });
}

const files = ["src", "test"].flatMap((directory) => jsFiles(path.join(root, directory)));
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) failures += 1;
}
console.log(`Syntax checked ${files.length} JavaScript files; ${failures} failed.`);
process.exitCode = failures ? 1 : 0;
