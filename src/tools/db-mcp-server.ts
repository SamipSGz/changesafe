/**
 * "db" MCP server -- ChangeSafe's tools.
 * ========================================
 *
 *   - inspect_schema      read-only, no approval
 *   - query_readonly      read-only, no approval (SQLite-enforced: this
 *                          tool's connection is physically opened as
 *                          readonly, so even a malicious/buggy SQL string
 *                          cannot write)
 *   - preview_change       read-only, no approval -- computes the exact
 *                          blast radius of a proposed customer merge and
 *                          logs it under a change_id. Never mutates
 *                          business data.
 *   - commit_change        WRITE, requires human approval (see
 *                          require_approval_for_tools in agentSpec.ts).
 *                          Takes ONLY a change_id -- no other parameters --
 *                          so whatever a human reviewed and approved is
 *                          exactly what executes. There is no way for this
 *                          call to smuggle in a different, bigger action
 *                          than the one that was previewed.
 *   - rollback_change      WRITE, but NOT approval-gated: undoing an
 *                          already-approved action is treated as safe and
 *                          recoverable, not as a new risk. We don't gate
 *                          the undo button.
 *
 * "Autonomy for observation, friction for mutation": four of these five
 * tools run freely so the agent can investigate on its own; only the one
 * tool that permanently deletes rows pauses for a human.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { readonlyDb, writeDb } from "../db/client.js";
import { getChange, insertPreview, markCommitted, markRolledBack } from "../db/changeLog.js";
import { applyMerge, computeMergeManifest, undoMerge, type MergeUndoSnapshot } from "../db/mergeOperation.js";

const PORT = Number(process.env.DB_MCP_PORT ?? 8791);
const MAX_QUERY_ROWS = 200;

// A cheap but real second line of defense on top of the readonly SQLite
// connection: refuse anything that isn't visibly a single SELECT before it
// ever reaches the database at all.
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;

function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(trimmed)) {
    throw new Error("Only a single SELECT statement is allowed.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed (no semicolon-separated batches).");
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error("That looks like a write statement; query_readonly only runs SELECTs.");
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "db", version: "0.1.0" });

  server.registerTool(
    "inspect_schema",
    {
      title: "Inspect schema",
      description:
        "Lists every table, its columns, and its foreign keys in the demo database. Read-only, no approval needed.",
      inputSchema: {},
    },
    async () => {
      const db = readonlyDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];

      const schema = tables.map(({ name }) => ({
        table: name,
        columns: db.prepare(`PRAGMA table_info(${name})`).all(),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
      }));

      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    },
  );

  server.registerTool(
    "query_readonly",
    {
      title: "Query (read-only)",
      description:
        "Runs a single SELECT statement against the demo database and returns up to 200 rows. " +
        "This tool's database connection is opened read-only by SQLite itself, so it cannot write " +
        "no matter what SQL text it's given. No approval needed. Use this to investigate -- e.g. " +
        "find duplicate customers with: SELECT email, GROUP_CONCAT(id) FROM customers GROUP BY email HAVING COUNT(*) > 1",
      inputSchema: {
        sql: z.string().min(1).describe("A single SELECT statement"),
      },
    },
    async ({ sql }) => {
      assertReadOnlySql(sql);
      const rows = readonlyDb().prepare(sql).all();
      const truncated = rows.length > MAX_QUERY_ROWS;
      const result = { rowCount: rows.length, truncated, rows: rows.slice(0, MAX_QUERY_ROWS) };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "preview_change",
    {
      title: "Preview change (dry run)",
      description:
        "Computes the exact blast radius of merging duplicate customer records -- how many orders " +
        "and support tickets would be reassigned, whether any affected orders are still active, and " +
        "how many customer rows would be deleted -- WITHOUT changing anything. Returns a change_id " +
        "that commit_change can later execute. Read-only, no approval needed.",
      inputSchema: {
        keep_id: z.number().int().positive().describe("Customer id to keep (the canonical record)"),
        remove_ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe("Duplicate customer id(s) to merge into keep_id and delete"),
      },
    },
    async ({ keep_id, remove_ids }) => {
      const db = writeDb(); // only used for the change_log bookkeeping insert below
      const manifest = computeMergeManifest(db, { keepId: keep_id, removeIds: remove_ids });
      const changeId = insertPreview(db, manifest.operation, { keepId: keep_id, removeIds: remove_ids }, manifest);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ change_id: changeId, manifest }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "commit_change",
    {
      title: "Commit change",
      description:
        "Executes a previously previewed change, identified ONLY by change_id -- there is no way to " +
        "pass different parameters here than what was previewed and reviewed. IRREVERSIBLE without " +
        "rollback_change. Requires human approval.",
      inputSchema: {
        change_id: z.string().min(1),
      },
    },
    async ({ change_id }) => {
      const db = writeDb();
      const row = getChange(db, change_id);
      if (!row) throw new Error(`No such change_id: ${change_id}`);
      if (row.status !== "previewed") {
        throw new Error(`change ${change_id} is already "${row.status}", not "previewed" -- refusing to re-run it.`);
      }
      const params = JSON.parse(row.params) as { keepId: number; removeIds: number[] };

      const commitTxn = db.transaction(() => {
        const undoSnapshot = applyMerge(db, params);
        markCommitted(db, change_id, undoSnapshot);
        return undoSnapshot;
      });
      const undoSnapshot = commitTxn();

      return {
        content: [
          {
            type: "text",
            text: `Change ${change_id} committed: ${undoSnapshot.removedCustomers.length} customer(s) deleted, ` +
              `${undoSnapshot.reassignedOrders.length} order(s) and ${undoSnapshot.reassignedTickets.length} ` +
              `ticket(s) reassigned to customer ${params.keepId}. Call rollback_change with this change_id to undo.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "rollback_change",
    {
      title: "Rollback change",
      description:
        "Reverses a committed change exactly, restoring the deleted customer row(s) and re-pointing " +
        "orders/tickets back to their original owner. Not approval-gated -- undoing an approved change " +
        "is treated as safe and recoverable, not as a new risk.",
      inputSchema: {
        change_id: z.string().min(1),
      },
    },
    async ({ change_id }) => {
      const db = writeDb();
      const row = getChange(db, change_id);
      if (!row) throw new Error(`No such change_id: ${change_id}`);
      if (row.status !== "committed") {
        throw new Error(`change ${change_id} is "${row.status}", not "committed" -- nothing to roll back.`);
      }
      const snapshot = JSON.parse(row.undo_snapshot ?? "null") as MergeUndoSnapshot | null;
      if (!snapshot) throw new Error(`change ${change_id} has no undo snapshot recorded.`);

      const rollbackTxn = db.transaction(() => {
        undoMerge(db, snapshot);
        markRolledBack(db, change_id);
      });
      rollbackTxn();

      return {
        content: [
          {
            type: "text",
            text: `Change ${change_id} rolled back: restored ${snapshot.removedCustomers.length} customer(s), ` +
              `${snapshot.reassignedOrders.length} order(s), and ${snapshot.reassignedTickets.length} ticket(s) to their original state.`,
          },
        ],
      };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

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

// Loopback only -- this server has no auth of its own. See README
// "Control & Safety" for why that boundary matters once commit_change can
// actually delete rows.
const HOST = "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`[db-mcp-server] listening on http://${HOST}:${PORT}/mcp (loopback only)`);
  console.log("Tools: inspect_schema, query_readonly, preview_change, commit_change, rollback_change");
  console.log("Register this URL in TrueForge -> Settings -> Connectors.");
  console.log("Run `npm run db:seed` first if you haven't already.");
});
