/**
 * "actions" MCP server
 * =====================
 * Exposes three tools that stand in for real-world, hard-to-undo actions:
 *
 *   - send_email             (would hit an SMTP/API relay)
 *   - create_support_ticket  (would hit a ticketing system, e.g. Zendesk/Jira)
 *   - book_meeting           (would hit a calendar API)
 *
 * This server does NOT decide whether an action is allowed to run -- that
 * decision belongs to the human, via TrueForge's approval gate
 * (`require_approval_for_tools`, configured in src/agent/agentSpec.ts).
 * By the time a tool handler in this file executes, a person has already
 * clicked "allow" on that specific call. Every execution is also appended
 * to an audit log (data/audit-log.json) for traceability.
 *
 * Run it:  npm run tools:dev
 * Then register it in TrueForge under Settings -> Connectors as a custom
 * MCP server pointing at http://localhost:8791/mcp (see README.md).
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  appendAudit,
  newId,
  saveEmail,
  saveMeeting,
  saveTicket,
} from "./store.js";

const PORT = Number(process.env.ACTIONS_MCP_PORT ?? 8791);

function buildServer(): McpServer {
  const server = new McpServer({ name: "actions", version: "0.1.0" });

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Sends an email on the user's behalf. IRREVERSIBLE once sent -- requires human approval.",
      inputSchema: {
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().min(1),
        body: z.string().min(1),
      },
    },
    async ({ to, subject, body }) => {
      const email = { id: newId("email"), to, subject, body, sentAt: new Date().toISOString() };
      saveEmail(email);
      appendAudit({ id: email.id, tool: "send_email", args: { to, subject }, result: email, timestamp: email.sentAt });
      return {
        content: [{ type: "text", text: `Email sent to ${to} (id: ${email.id}).` }],
      };
    },
  );

  server.registerTool(
    "create_support_ticket",
    {
      title: "Create support ticket",
      description:
        "Files a support ticket in the ticketing system. Creates real work for a human team -- requires approval.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().min(1),
        priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
      },
    },
    async ({ title, description, priority }) => {
      const ticket = {
        id: newId("ticket"),
        title,
        description,
        priority,
        createdAt: new Date().toISOString(),
      };
      saveTicket(ticket);
      appendAudit({ id: ticket.id, tool: "create_support_ticket", args: { title, priority }, result: ticket, timestamp: ticket.createdAt });
      return {
        content: [{ type: "text", text: `Ticket ${ticket.id} created (priority: ${priority}).` }],
      };
    },
  );

  server.registerTool(
    "book_meeting",
    {
      title: "Book meeting",
      description:
        "Books a calendar meeting and invites attendees. Costs other people's time -- requires approval.",
      inputSchema: {
        title: z.string().min(1),
        attendees: z.array(z.string().email()).min(1),
        startTime: z.string().describe("ISO-8601 datetime"),
        durationMinutes: z.number().int().positive().default(30),
      },
    },
    async ({ title, attendees, startTime, durationMinutes }) => {
      const meeting = {
        id: newId("meeting"),
        title,
        attendees,
        startTime,
        durationMinutes,
        createdAt: new Date().toISOString(),
      };
      saveMeeting(meeting);
      appendAudit({ id: meeting.id, tool: "book_meeting", args: { title, attendees, startTime }, result: meeting, timestamp: meeting.createdAt });
      return {
        content: [{ type: "text", text: `Meeting "${title}" booked at ${startTime} with ${attendees.length} attendee(s).` }],
      };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

// One MCP server + transport per session, keyed by the MCP session id --
// the standard pattern for a stateful Streamable HTTP MCP server.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) transports.delete(transport.sessionId);
    };
    await buildServer().connect(transport);
  }

  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session. Send an initialize request first." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

async function handleSessionRequest(req: express.Request, res: express.Response) {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  console.log(`[actions-mcp-server] listening on http://localhost:${PORT}/mcp`);
  console.log("Tools: send_email, create_support_ticket, book_meeting");
  console.log("Register this URL in TrueForge -> Settings -> Connectors.");
});
