import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

export interface SessionListItem {
  index: number;
  workspace: string;
  title: string;
  firstUserMessage: string;
  relativeTime: string;
  model?: string;
  isActive: boolean;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start a new thread"],
        ["/session", "Current thread details"],
        ["/sessions", "Browse & switch threads"],
        ["/attach", "Bind a Codex thread to this topic"],
        ["/handback", "Hand thread back to Codex CLI"],
        ["/abort", "Cancel current operation"],
        ["/retry", "Resend the last prompt"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/launch_profiles", "Select launch profile"],
        ["/model", "View & change model"],
        ["/effort", "Set reasoning effort"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/status", "Codex quota status"],
        ["/quota", "Codex quota status"],
        ["/help", "This reference"],
        ["/voice", "Voice transcription status"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCodex is ready.</b>",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];
  const plainLines = [
    "👋 TeleCodex is ready.",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex (topic session)" : "TeleCodex";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    index?: number;
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const number = options.index === undefined ? "" : `${options.index}. `;
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 10) || "(unknown)";
  const title = trimLabel(options.title || "(untitled)", 34) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${number}${title} · ${workspaceName} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

export function renderSessionListMessage(items: SessionListItem[], totalCount: number): DualText {
  const htmlLines = [`<b>Recent threads</b> (${totalCount})`, "Tap a numbered button to switch.", ""];
  const plainLines = [`Recent threads (${totalCount})`, "Tap a numbered button to switch.", ""];

  for (const item of items) {
    const title = sessionTitle(item);
    const workspaceName = getWorkspaceShortName(item.workspace) || "(unknown)";
    const details = [workspaceName, item.relativeTime, item.model].filter(Boolean).join(" · ");
    const marker = item.isActive ? " ✅" : "";
    const firstMessage = sessionFirstMessage(item);

    htmlLines.push(`<b>${item.index}.${marker} ${escapeHTML(title)}</b>`);
    htmlLines.push(escapeHTML(details));
    plainLines.push(`${item.index}.${marker} ${title}`);
    plainLines.push(details);

    if (firstMessage && firstMessage !== title) {
      const preview = trimLabel(firstMessage, 120);
      htmlLines.push(`<i>${escapeHTML(preview)}</i>`);
      plainLines.push(preview);
    }

    htmlLines.push("");
    plainLines.push("");
  }

  if (totalCount > items.length) {
    const remaining = totalCount - items.length;
    htmlLines.push(`<i>${remaining} more on later pages.</i>`);
    plainLines.push(`${remaining} more on later pages.`);
  }

  return {
    html: htmlLines.join("\n").trimEnd(),
    plain: plainLines.join("\n").trimEnd(),
  };
}

function sessionTitle(item: Pick<SessionListItem, "title" | "firstUserMessage">): string {
  return trimLabel(item.title || item.firstUserMessage || "(untitled)", 80) || "(untitled)";
}

function sessionFirstMessage(item: Pick<SessionListItem, "firstUserMessage">): string {
  return item.firstUserMessage.replace(/\s+/g, " ").trim();
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
