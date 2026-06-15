import { agentDisplayName, getActiveAgent, initAgentState } from "./agent-state.js";
import { createBot, registerCommands } from "./bot.js";
import { checkAuthForAgent } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { SessionRegistry } from "./session-registry.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;

try {
  const config = loadConfig();
  initAgentState(config.workspace);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  await registerCommands(bot);

  const activeAgent = getActiveAgent();
  console.log(`TeleCodex running — active agent: ${agentDisplayName(activeAgent)}`);

  const codexAuth = await checkAuthForAgent("codex");
  const claudeAuth = await checkAuthForAgent("claude");

  const authLine = (label: string, auth: typeof codexAuth) =>
    `  ${label}: ${auth.authenticated ? "authenticated" : "not authenticated"} (${auth.method})`;

  console.log("Auth status:");
  console.log(authLine("Codex", codexAuth));
  console.log(authLine("Claude Code", claudeAuth));

  if (!codexAuth.authenticated && !claudeAuth.authenticated) {
    console.warn("Warning: neither agent is authenticated. Run 'codex login' or 'claude' on the host to log in.");
  }

  console.log(`Workspace root: ${config.workspaceRoot}`);

  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCodex: ${message}`);
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TeleCodex...`);
  if (bot) bot.stop();

  setTimeout(() => {
    registry?.disposeAll();
    console.log("TeleCodex stopped.");
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: true,
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
