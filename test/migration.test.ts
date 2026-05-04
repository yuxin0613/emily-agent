import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { ExperienceStore } from "../src/experience/ExperienceStore.ts";
import { SkillCandidateStore } from "../src/skills/SkillCandidateStore.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";

const execFileAsync = promisify(execFile);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-migration-"));
const taskStore = await TaskStore.create({ dataDir });
const experienceStore = ExperienceStore.create({ dataDir });
const skillCandidateStore = SkillCandidateStore.create({ dataDir, skillDir: path.join(dataDir, "skills") });

const db = new DatabaseSync(path.join(dataDir, "emily.sqlite"));
const rows = db
  .prepare("SELECT namespace, version, name FROM schema_migrations ORDER BY namespace, version")
  .all() as Array<{ namespace: string; version: number; name: string }>;

assert.ok(rows.some((row) => row.namespace === "task" && row.version === 1));
assert.ok(rows.some((row) => row.namespace === "task" && row.version === 2));
assert.ok(rows.some((row) => row.namespace === "task" && row.version === 3));
assert.ok(rows.some((row) => row.namespace === "task" && row.version === 4));
assert.ok(rows.some((row) => row.namespace === "task" && row.version === 5));
assert.ok(rows.some((row) => row.namespace === "task" && row.version === 6));
assert.ok(rows.some((row) => row.namespace === "experience" && row.version === 1));
assert.ok(rows.some((row) => row.namespace === "experience" && row.version === 2));
assert.ok(rows.some((row) => row.namespace === "experience" && row.version === 3));
assert.ok(rows.some((row) => row.namespace === "experience" && row.version === 4));
assert.ok(rows.some((row) => row.namespace === "skill" && row.version === 1));

db.close();
skillCandidateStore.close();
experienceStore.close();
taskStore.close();

const concurrentDataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-migration-concurrent-"));
const env = { ...process.env, EMILY_DATA_DIR: concurrentDataDir };
const concurrent = await Promise.allSettled([
  execFileAsync(process.execPath, ["src/index.ts", "--doctor", "--deep"], {
    cwd: process.cwd(),
    env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }),
  execFileAsync(process.execPath, ["src/index.ts", "--security-audit"], {
    cwd: process.cwd(),
    env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }),
]);
assert.equal(concurrent[0].status, "fulfilled", concurrent[0].status === "rejected" ? String(concurrent[0].reason) : "");
assert.equal(concurrent[1].status, "fulfilled", concurrent[1].status === "rejected" ? String(concurrent[1].reason) : "");

console.log("migration test passed");
