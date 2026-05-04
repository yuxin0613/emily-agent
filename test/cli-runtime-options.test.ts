import assert from "node:assert/strict";
import { shouldStartCronForCliArgs } from "../src/runtime/CronStartup.ts";

assert.equal(shouldStartCronForCliArgs([]), true);
assert.equal(shouldStartCronForCliArgs(["--tui"]), true);
assert.equal(shouldStartCronForCliArgs(["--web"]), true);
assert.equal(shouldStartCronForCliArgs(["--cron"]), true);
assert.equal(shouldStartCronForCliArgs(["model"]), false);
assert.equal(shouldStartCronForCliArgs(["update"]), false);
assert.equal(shouldStartCronForCliArgs(["--doctor"]), false);
assert.equal(shouldStartCronForCliArgs(["--doctor", "--deep"]), false);
assert.equal(shouldStartCronForCliArgs(["--security-audit"]), false);
assert.equal(shouldStartCronForCliArgs(["--cron-once"]), false);

console.log("cli runtime options test passed");
