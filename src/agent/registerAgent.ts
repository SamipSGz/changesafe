/**
 * Optional convenience script: saves the agent defined in agentSpec.ts to
 * TrueForge's Agents Library so it shows up by name in the chat UI, instead
 * of only being usable via the inline spec in src/cli.ts.
 *
 * Requires the "actions" connector to already be registered under
 * Settings -> Connectors (see README.md), otherwise agent creation will
 * fail to resolve the mcp_servers[0].name reference.
 *
 * Usage: npm run agent:register
 */
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { AGENT_NAME, agentManifest } from "./agentSpec.js";

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
  timeoutInSeconds: 60,
});

const { data: agent } = await client.agents.create({
  name: AGENT_NAME,
  manifest: agentManifest,
});

console.log(`Registered agent "${agent.name}" in the TrueForge Agents Library.`);
console.log(`Open the TrueForge chat UI and select "${AGENT_NAME}" to talk to it,`);
console.log(`or run "npm run cli" for the terminal client with approval prompts.`);
