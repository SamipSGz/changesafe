/**
 * Terminal client for the "changesafe" agent.
 *
 * Talks to a locally running TrueForge server (npx @truefoundry/trueforge),
 * streams the agent's turns, and -- the point of this whole project --
 * stops and asks a human before letting the agent execute commit_change,
 * which permanently deletes customer rows. Nothing in the "db" MCP server
 * mutates anything until you type "y" here.
 *
 * Persists its session id to disk (data/session.json) and resumes it on
 * the next run instead of always starting fresh -- demonstrating
 * TrueForge's session persistence: kill this process mid-conversation
 * (even mid-approval-pause) and restart it, and the agent picks up where
 * it left off with full context intact.
 *
 * Usage: npm run cli
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  TrueForge,
  type TrueForgeApi,
  isEventDelta,
  mergeEventDelta,
} from "@truefoundry/trueforge-sdk";
import { agentManifest } from "./agent/agentSpec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(__dirname, "..", "data", "session.json");

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
  timeoutInSeconds: 600,
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

function loadSavedSessionId(): string | undefined {
  if (!existsSync(SESSION_FILE)) return undefined;
  try {
    return (JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as { sessionId?: string }).sessionId;
  } catch {
    return undefined;
  }
}

function saveSessionId(sessionId: string): void {
  const dir = dirname(SESSION_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }, null, 2), "utf-8");
}

/** Reuse the last session if it still exists on the server; otherwise
 * start a fresh one. This is what makes "kill the process, restart it"
 * resume the same conversation instead of losing it. */
async function getOrCreateSession(): Promise<{ id: string; resumed: boolean }> {
  const savedId = loadSavedSessionId();
  if (savedId) {
    try {
      const { data: session } = await client.sessions.get(savedId);
      return { id: session.id, resumed: true };
    } catch {
      // Saved session no longer exists on the server (fresh `npx trueforge`
      // instance, expired, etc.) -- fall through and create a new one.
    }
  }
  const { data: session } = await client.sessions.create({ agent: { spec: agentManifest } });
  saveSessionId(session.id);
  return { id: session.id, resumed: false };
}

/** Stream one turn's events, print model text as it arrives, and return any
 * pending approval requests plus the running event index (needed to look up
 * each pending call's name/arguments). */
async function streamTurn(
  sessionId: string,
  input: TrueForgeApi.TurnInputItem[],
  events: Map<string, TrueForgeApi.TurnStreamingEvent>,
): Promise<TrueForgeApi.ToolApprovalRequiredEvent[]> {
  const pending: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
  const stream = await client.sessions.createTurnStream(sessionId, { input });

  for await (const { data: event } of stream.withMetadata()) {
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
    } else {
      events.set(event.id, event);
    }

    if (event.type === "model.message.delta" && "content" in event) {
      process.stdout.write(event.content ?? "");
    }
    if (event.type === "tool.approval_required") {
      pending.push(event as TrueForgeApi.ToolApprovalRequiredEvent);
    }
  }
  process.stdout.write("\n");
  return pending;
}

/** Print each pending tool call and ask a human to allow or deny it. */
async function collectApprovals(
  pending: TrueForgeApi.ToolApprovalRequiredEvent[],
  events: Map<string, TrueForgeApi.TurnStreamingEvent>,
): Promise<TrueForgeApi.UserToolApprovalEvent[]> {
  const approvals: TrueForgeApi.UserToolApprovalEvent[] = [];

  for (const req of pending) {
    for (const ref of req.toolCalls) {
      const msg = events.get(ref.sourceEventId);
      const call =
        msg?.type === "model.message" ? msg.toolCalls?.find((tc) => tc.id === ref.id) : undefined;
      let args: unknown = call?.function.arguments;
      try {
        if (typeof args === "string") args = JSON.parse(args);
      } catch {
        // leave as raw string if it doesn't parse
      }

      console.log("\n--- APPROVAL REQUIRED -----------------------------------");
      console.log(`tool:      ${call?.function.name ?? "(unknown)"}`);
      console.log(`arguments: ${JSON.stringify(args ?? {}, null, 2)}`);
      console.log("-----------------------------------------------------------");

      const answer = (await rl.question("Allow this action? [y/N] ")).trim().toLowerCase();
      approvals.push({
        type: "user.tool_approval",
        threadId: req.threadId,
        toolCallId: ref.id,
        approval:
          answer === "y" || answer === "yes"
            ? { status: "allow" }
            : { status: "deny", reason: "denied by user in CLI" },
      });
    }
  }
  return approvals;
}

async function main() {
  const { id: sessionId, resumed } = await getOrCreateSession();
  console.log(
    resumed
      ? `Resumed session ${sessionId} -- picking up where you left off.`
      : `Started session ${sessionId}.`,
  );
  console.log('Try: "Find any duplicate customers and tell me what merging them would affect."');
  console.log('Type "exit" to quit (the session stays resumable next run).\n');

  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();

  while (true) {
    const userText = await rl.question("> ");
    if (userText.trim().toLowerCase() === "exit") break;

    let pending = await streamTurn(sessionId, [{ type: "user.message", content: userText }], events);

    // An agent turn can pause for approval more than once in a row
    // (e.g. two tool calls back to back) -- keep resolving until the
    // turn actually finishes.
    while (pending.length > 0) {
      const approvals = await collectApprovals(pending, events);
      pending = await streamTurn(sessionId, approvals, events);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  rl.close();
  process.exit(1);
});
