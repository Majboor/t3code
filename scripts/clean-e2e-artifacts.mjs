#!/usr/bin/env node
/**
 * Removes what the end-to-end suites leave behind.
 *
 * Every suite makes a real account, a real folder on the Desktop, and a real
 * project pointing at it — that is the point, since a fake one would not prove
 * anything. What none of them did was tidy up, so a few dozen runs buried the
 * real projects in the sidebar under `t3-collab-1786...` rows whose folders had
 * already been deleted.
 *
 * Only paths the suites themselves create are touched: the `t3-<suite>-<stamp>`
 * convention under the Desktop and the temp dir. Anything else stays, including
 * the test accounts' own workspaces — those live in their own tenants and never
 * appear in anybody else's sidebar, so deleting them buys nothing and risks
 * something.
 *
 * Projects are marked deleted rather than dropped, which is what the app itself
 * does when you remove one; a hard delete would leave threads pointing at a row
 * that no longer exists.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DB = path.join(HOME, ".t3", "dev", "state.sqlite");

/** The roots a suite is allowed to have written to. */
const SUITE_ROOT_PATTERNS = [
  `${path.join(HOME, "Desktop")}/t3-%`,
  "/tmp/t3-%",
  "/private/tmp/%t3-%",
];

const dryRun = process.argv.includes("--dry-run");

function sqlite(sql) {
  return execFileSync("sqlite3", [DB, sql], { encoding: "utf8" }).trim();
}

function main() {
  let removedFolders = 0;
  for (const entry of fs.readdirSync(path.join(HOME, "Desktop"))) {
    if (!/^t3-[a-z]+-\d{10,}/.test(entry)) continue;
    if (!dryRun) fs.rmSync(path.join(HOME, "Desktop", entry), { recursive: true, force: true });
    removedFolders += 1;
  }

  if (!fs.existsSync(DB)) {
    console.log(`Removed ${removedFolders} folder(s). No database at ${DB}, so nothing to unlist.`);
    return;
  }

  const where = `deleted_at is null and (${SUITE_ROOT_PATTERNS.map(
    (pattern) => `workspace_root like '${pattern}'`,
  ).join(" or ")})`;

  const count = Number(sqlite(`select count(*) from projection_projects where ${where};`));
  if (!dryRun && count > 0) {
    sqlite(
      `update projection_projects set deleted_at = datetime('now'), updated_at = datetime('now') where ${where};`,
    );
  }

  const kept = sqlite(`select count(*) from projection_projects where deleted_at is null;`);
  console.log(
    dryRun
      ? `Would remove ${removedFolders} folder(s) and unlist ${count} project(s).`
      : `Removed ${removedFolders} folder(s), unlisted ${count} project(s). ${kept} project(s) remain.`,
  );
}

main();
