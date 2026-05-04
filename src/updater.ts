import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UpdateCommand {
  command: string;
  args: string[];
  installerPath: string;
}

export function buildUpdateCommand({
  env = process.env,
  installDir = resolveInstallDir(env),
  userArgs = [],
}: {
  env?: NodeJS.ProcessEnv;
  installDir?: string;
  userArgs?: string[];
} = {}): UpdateCommand {
  const installerPath = path.join(installDir, "scripts", "install.sh");
  const args = [installerPath, ...userArgs];

  if (!hasHelpFlag(userArgs)) {
    appendOption(args, userArgs, "--dir", installDir);
    appendOption(args, userArgs, "--bin-dir", env.EMILY_BIN_DIR);
    appendOption(args, userArgs, "--name", env.EMILY_COMMAND_NAME);
  }

  return { command: "bash", args, installerPath };
}

export function runUpdate(userArgs: string[] = []): number {
  const update = buildUpdateCommand({ userArgs });

  if (!existsSync(update.installerPath)) {
    console.error(`Emily updater could not find installer: ${update.installerPath}`);
    return 1;
  }

  const result = spawnSync(update.command, update.args, {
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") return result.status;
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Emily update terminated by signal ${result.signal}.`);
  return 1;
}

function resolveInstallDir(env: NodeJS.ProcessEnv): string {
  if (env.EMILY_INSTALL_DIR?.trim()) return env.EMILY_INSTALL_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function appendOption(args: string[], userArgs: string[], option: string, value?: string): void {
  if (!value || hasOption(userArgs, option)) return;
  args.push(option, value);
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}

function hasOption(args: string[], option: string): boolean {
  return args.includes(option);
}
