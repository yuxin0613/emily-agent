export function shouldStartCronForCliArgs(rawArgs: string[]): boolean {
  const args = new Set(rawArgs);
  if (rawArgs[0] === "model") return false;
  if (rawArgs[0] === "update") return false;
  if (args.has("--doctor") || args.has("--security-audit") || args.has("--cron-once")) return false;
  return true;
}
