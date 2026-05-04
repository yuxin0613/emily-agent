import assert from "node:assert/strict";
import { buildUpdateCommand } from "../src/updater.ts";

const command = buildUpdateCommand({
  installDir: "/tmp/emily-agent",
  env: {
    EMILY_BIN_DIR: "/tmp/bin",
    EMILY_COMMAND_NAME: "emily-dev",
  },
  userArgs: ["--branch", "dev"],
});

assert.equal(command.command, "bash");
assert.deepEqual(command.args, [
  "/tmp/emily-agent/scripts/install.sh",
  "--branch",
  "dev",
  "--dir",
  "/tmp/emily-agent",
  "--bin-dir",
  "/tmp/bin",
  "--name",
  "emily-dev",
]);

const explicit = buildUpdateCommand({
  installDir: "/tmp/emily-agent",
  env: {
    EMILY_BIN_DIR: "/tmp/bin",
    EMILY_COMMAND_NAME: "emily-dev",
  },
  userArgs: ["--dir", "/custom/install", "--bin-dir", "/custom/bin", "--name", "custom-emily"],
});

assert.deepEqual(explicit.args, [
  "/tmp/emily-agent/scripts/install.sh",
  "--dir",
  "/custom/install",
  "--bin-dir",
  "/custom/bin",
  "--name",
  "custom-emily",
]);

const help = buildUpdateCommand({
  installDir: "/tmp/emily-agent",
  env: {
    EMILY_BIN_DIR: "/tmp/bin",
    EMILY_COMMAND_NAME: "emily-dev",
  },
  userArgs: ["--help"],
});

assert.deepEqual(help.args, ["/tmp/emily-agent/scripts/install.sh", "--help"]);

console.log("updater test passed");
