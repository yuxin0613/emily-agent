import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function startTui({ runtime }) {
  const rl = readline.createInterface({ input, output });
  const sessionId = "tui";

  output.write("Emily Agent TUI\n");
  output.write("输入 exit 退出。\n\n");

  try {
    while (true) {
      const message = await rl.question("> ");
      if (["exit", "quit", ":q"].includes(message.trim().toLowerCase())) {
        break;
      }

      const response = await runtime.handleUserMessage(message, {
        sessionId,
        source: "tui",
      });

      output.write(`\n${response.content}\n`);
      output.write(`\n[delegated: ${response.delegatedTo.join(", ")}]\n\n`);
    }
  } finally {
    rl.close();
  }
}
