import { spawn } from "node:child_process";
import readline from "node:readline";

interface JsonRpcMessage {
  id?: number;
  error?: {
    message?: string;
  };
}

const APP_SERVER_TIMEOUT_MS = 15000;
const MAX_THREAD_NAME_LENGTH = 120;

export async function renameCodexThread(
  threadId: string,
  name: string,
  codexApiKey?: string,
): Promise<void> {
  const trimmedName = normalizeThreadName(name);

  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    if (codexApiKey) {
      env.CODEX_API_KEY = codexApiKey;
    }

    const child = spawn("codex", ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const rl = readline.createInterface({ input: child.stdout });
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Timed out renaming Codex thread.")));
    }, APP_SERVER_TIMEOUT_MS);

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      child.kill("SIGTERM");
      fn();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("exit", (code, signal) => {
      if (!settled && code !== 0) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        settle(() => reject(new Error(`Codex app-server exited with ${detail}${stderr ? `: ${stderr}` : ""}`)));
      }
    });

    rl.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }

      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        child.stdin.write(
          `${JSON.stringify({
            method: "thread/name/set",
            id: 2,
            params: {
              threadId,
              name: trimmedName,
            },
          })}\n`,
        );
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          settle(() => reject(new Error(message.error?.message || "Failed to rename Codex thread.")));
          return;
        }

        settle(() => resolve());
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "telecodex",
            title: "TeleCodex",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      })}\n`,
    );
  });
}

export function normalizeThreadName(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Usage: /rename <new session title>");
  }

  return normalized.length <= MAX_THREAD_NAME_LENGTH
    ? normalized
    : normalized.slice(0, MAX_THREAD_NAME_LENGTH).trimEnd();
}
