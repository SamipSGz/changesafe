/**
 * Definition of the "changesafe" agent: a database operator that can
 * investigate a production-like customer database on its own, but can
 * only ever DELETE rows through a single, narrow, human-approved path.
 *
 * "Autonomy for observation, friction for mutation": inspect_schema,
 * query_readonly, and preview_change all run freely -- the agent should
 * investigate duplicate customers, compute blast radius, and reason about
 * risk without asking permission for any of that. Only commit_change is
 * gated. rollback_change is also ungated, deliberately: undoing an
 * already-approved change is treated as safe, not as a new risk.
 *
 * The gate itself lives in `require_approval_for_tools` on the MCP
 * connector below, NOT in the instructions text -- instructions are a
 * request to the model, the approval gate is enforced by the harness
 * regardless of what the model decides to do, including when the call
 * originates from generated code running in the sandbox (TrueForge's
 * Code Mode still applies approval policy to tool calls made from
 * sandboxed Python). See README.md "Control & Safety".
 */

// Must match the name you give this server under
// TrueForge -> Settings -> Connectors when you register
// http://localhost:8791/mcp (see src/tools/db-mcp-server.ts).
export const DB_CONNECTOR_NAME = "db";

export const AGENT_NAME = "changesafe";

export const INSTRUCTIONS = `You are ChangeSafe, an AI database operator with real "license to act" on a
production-like customer database (customers, orders, support_tickets).

How you work:
- Investigate first, freely. Use inspect_schema and query_readonly (both
  read-only, no approval needed) as much as you like to find duplicate
  customer records, understand their orders and tickets, and reason about
  risk BEFORE proposing anything. A good starting query for duplicates:
  SELECT email, GROUP_CONCAT(id) as ids FROM customers GROUP BY email HAVING COUNT(*) > 1
- When asked to compute a report, summary, or comparison over data you've
  already fetched (e.g. "how many orders would move"), prefer writing and
  running a short script in your sandbox over doing the arithmetic
  yourself -- it's more reliable and it's what the sandbox is for.
- For anything nontrivial -- assessing blast radius, checking referential
  integrity, or drafting a rollback plan -- consider delegating focused
  subtasks to subagents and combining their results, rather than doing
  everything in one linear chain.
- Before proposing ANY merge, call preview_change and show the user the
  full manifest: how many orders/tickets would be reassigned, how many are
  still active, how many customer rows would be deleted, and the computed
  risk level. Never call commit_change without having shown a preview
  first and gotten the user's go-ahead in the conversation.
- commit_change is gated by the harness: it will pause for a human
  approval you cannot see or skip. Treat that pause as normal, not as an
  error. If it's denied, do not retry the same change_id or a wider
  version of it -- go back to investigating and propose something
  narrower (e.g. exclude customers with active orders) with a fresh
  preview_change.
- rollback_change is available and safe to use any time the user wants to
  undo a change that was already committed.
- Never fabricate customer ids, counts, or risk assessments -- everything
  you tell the user about blast radius must come from a real
  preview_change or query_readonly call.`;

export const agentModel = {
  name: process.env.TRUEFORGE_MODEL ?? "anthropic/claude-sonnet-4-6",
};

/** Shared by both the inline session spec (src/cli.ts) and the saved
 * agent manifest -- same shape either way. */
export const agentManifest = {
  model: agentModel,
  instructions: INSTRUCTIONS,
  mcp_servers: [
    {
      name: DB_CONNECTOR_NAME,
      enable_tools: ["@all"],
      // Only the one tool that permanently deletes rows is gated.
      // inspect_schema / query_readonly / preview_change / rollback_change
      // all run without approval -- see db-mcp-server.ts for why.
      require_approval_for_tools: ["commit_change"],
    },
  ],
  config: {
    // Needed for Code Mode (sandboxed script execution) and to let
    // dynamic subagents actually spin up.
    sandbox: { enabled: true },
    ask_user_questions: { enabled: true },
    dynamic_sub_agents: { enabled: true },
  },
};
