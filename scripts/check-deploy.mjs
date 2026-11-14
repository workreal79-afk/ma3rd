import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const errors = [];
const read = (name) => fs.readFileSync(path.join(projectRoot, name), "utf8");

const render = read("render.yaml");
const docker = read("Dockerfile");
const db = read("server/src/db/index.js");
const env = read("server/src/config/env.js");

if (!/^\s{4}plan:\s*starter\s*$/m.test(render)) {
  errors.push("Render production service must use a paid plan; Free has no persistent disk.");
}
if (!/mountPath:\s*\/app\/server\/data\s*$/m.test(render)) {
  errors.push("Persistent disk must mount at /app/server/data, where the SQLite database and backups are stored.");
}
if (!/sizeGB:\s*[1-9]\d*\s*$/m.test(render)) {
  errors.push("Persistent disk sizeGB must be an explicit positive integer.");
}
if (!/path\.join\(__dirname,\s*"\.\.",\s*"\.\.",\s*"data"\)/.test(db)) {
  errors.push("Database data directory changed; re-check the Render disk mount path.");
}
for (const key of ["SHOWROOM_AUTH_USER", "SHOWROOM_AUTH_PASS"]) {
  const section = render.match(new RegExp(`- key: ${key}\\n([\\s\\S]*?)(?=\\n      - key:|$)`));
  if (!section || !/sync:\s*false/.test(section[1])) {
    errors.push(`${key} must be provided as a secret in the Render dashboard (sync: false).`);
  }
}
if (!/key:\s*TZ\s*\n\s+value:\s*Asia\/Riyadh/.test(render)) {
  errors.push("Render TZ must remain Asia/Riyadh for due-date calculations.");
}
if (!/npm --prefix server ci --omit=dev/.test(docker) || !/npm --prefix client ci --include=dev/.test(docker)) {
  errors.push("Docker build must install server/client dependencies using their lockfiles.");
}
if ((docker.match(/npm --prefix client run build/g) || []).length !== 1) {
  errors.push("Dockerfile must build the client exactly once.");
}
if (/npm install --omit=dev && npm --prefix server install/.test(docker)) {
  errors.push("Dockerfile contains a duplicate non-lockfile dependency installation step.");
}
if (!/SHOWROOM_AUTO_BACKUP_RETENTION/.test(render) || !/SHOWROOM_AUTO_BACKUP_HOURS/.test(render)) {
  errors.push("Automatic backup cadence and retention must be explicitly configured.");
}
if (!/SHOWROOM_DB \|\| "showroom\.sqlite"/.test(env)) {
  errors.push("Review database filename configuration before changing SQLite persistence.");
}

if (errors.length) {
  console.error("Deploy configuration check FAILED:");
  for (const error of errors) console.error(` - ${error}`);
  process.exitCode = 1;
} else {
  console.log("Deploy configuration check passed: paid service, persistent SQLite data path, secret placeholders, Riyadh timezone, lockfile installs, one frontend build, backup configuration.");
}
