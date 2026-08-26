/**
 * Definition of the "license-to-act" agent: an assistant that can draft and
 * execute real-world actions (email / support ticket / calendar booking),
 * but must never execute one without a human explicitly approving it first.
 *
 * The approval gate lives in `require_approval_for_tools` on the MCP
 * connector below, NOT in the instructions text -- instructions are a
 * request to the model, the approval gate is enforced by the harness
 * regardless of what the model decides to do. See README.md "Control &
 * Safety" for why that distinction matters for this hackathon's judging.
 */

// Must match the name you give this server under
// TrueForge -> Settings -> Connectors when you register
// http://localhost:8791/mcp (see src/tools/actions-mcp-server.ts).
export const ACTIONS_CONNECTOR_NAME = "actions";

export const AGENT_NAME = "license-to-act";

export const INSTRUCTIONS = `You are a careful executive assistant with a real "license to act": you can
send emails, file support tickets, and book meetings on the user's behalf.

Rules:
- Always explain what you're about to do and why before calling a tool.
- Never fabricate recipients, ticket details, or meeting times -- ask the
  user for anything you don't have.
- Every action you take is reviewed by a human before it executes. Treat
  that pause as normal, not as an error: propose the action, then wait.
- If an approval is denied, do not retry the same action silently. Ask the
  user what they'd like to do instead.`;

export const agentModel = {
  name: process.env.TRUEFORGE_MODEL ?? "anthropic/claude-sonnet-4-6",
};

/** Shared by both the inline session spec (src/cli.ts) and the saved
 * agent manifest (src/agent/registerAgent.ts) -- same shape either way. */
export const agentManifest = {
  model: agentModel,
  instructions: INSTRUCTIONS,
  mcp_servers: [
    {
      name: ACTIONS_CONNECTOR_NAME,
      enable_tools: ["@all"],
      // Everything this connector exposes is a real-world side effect --
      // require a human "allow" on every single call, no exceptions.
      require_approval_for_tools: ["@all"],
    },
  ],
  config: {
    sandbox: { enabled: false },
    ask_user_questions: { enabled: true },
  },
};
