import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const script = path.join(process.cwd(), "scripts", "install.sh");

execFileSync("bash", ["-n", script], { stdio: "pipe" });
const help = execFileSync("bash", [script, "--help"], { encoding: "utf8" });

assert.match(help, /Emily AgentOS installer/);
assert.match(help, /--repo URL/);
assert.match(help, /Command name \(default: emily\)/);
assert.match(help, /https:\/\/github\.com\/yuxinhuang\/emily-agent\.git/);

console.log("install script test passed");
