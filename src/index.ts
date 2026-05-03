import { createRuntime } from "./runtime/createRuntime.ts";
import { startTui } from "./adapters/tui.ts";
import { startWebServer } from "./adapters/web.ts";

const args = new Set(process.argv.slice(2));
const runtime = await createRuntime();

if (args.has("--security-audit")) {
  console.log(JSON.stringify(await runtime.securityAudit(), null, 2));
  await runtime.shutdown();
} else if (args.has("--doctor")) {
  console.log(JSON.stringify(await runtime.doctor({
    deep: args.has("--deep"),
    repair: args.has("--repair"),
  }), null, 2));
  await runtime.shutdown();
} else if (args.has("--web")) {
  const port = Number(process.env.PORT || 3000);
  await startWebServer({ runtime, port });
} else {
  await startTui({ runtime });
}
