# License to Act

An approval-gated action assistant built on [TrueForge](https://trueforge.dev) for
the [Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
("Give AI models a License to act").

The agent can draft and send emails, file support tickets, and book meetings —
real actions with real consequences. It never executes one without a human
explicitly clicking "allow" first. That approval gate is the point of this
project, not an afterthought.

## Why this project

Judging weights "Control & Safety" as heavily as any other criterion: does the
agent run in an isolated sandbox, and does it pause for human approval before
irreversible actions? This project is built around that requirement instead
of bolting it on:

- Every side-effecting tool (`send_email`, `create_support_ticket`,
  `book_meeting`) lives behind TrueForge's `require_approval_for_tools`
  connector setting — see [`src/agent/agentSpec.ts`](src/agent/agentSpec.ts).
- The approval decision is enforced by the harness, not requested politely in
  a system prompt. The model cannot talk its way past it.
- Every executed action is appended to a local audit log
  (`data/audit-log.json`) for traceability.

## Architecture

```
┌──────────────┐   user message    ┌─────────────┐   tool call    ┌───────────────────┐
│  src/cli.ts  │ ─────────────────▶│  TrueForge  │───────────────▶│ actions MCP server │
│ (terminal    │                   │   server    │  (needs        │ (src/tools/)       │
│  client)     │◀───────────────── │  (harness)  │   approval)    │ send_email         │
└──────────────┘  approval_required└─────────────┘                │ create_support_    │
       │                                  ▲                        │   ticket           │
       │        human types y/n           │                        │ book_meeting       │
       └──────────────────────────────────┘                        └───────────────────┘
                                                                      writes to data/*.json
                                                                      + data/audit-log.json
```

- **TrueForge** (run via `npx @truefoundry/trueforge`) is the harness: it
  runs the agent loop, decides which tool calls need approval, and streams
  every step back to the client.
- **`src/tools/actions-mcp-server.ts`** is a small custom MCP server exposing
  the three action tools. It never checks whether it's "allowed" to run — by
  the time its handlers execute, TrueForge has already gated the call on a
  human decision.
- **`src/cli.ts`** is a terminal client using `@truefoundry/trueforge-sdk`. It
  streams the agent's turns, and when a `tool.approval_required` event
  arrives, it prints the exact tool name and arguments and asks a human
  before resuming the turn.

## Setup

Prerequisites: Node.js 20+, and your own API key for a model provider
(OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint).

```bash
git clone https://github.com/SamipSGz/license-to-act.git
cd license-to-act
npm install
cp .env.example .env
```

### 1. Start TrueForge

```bash
npx @truefoundry/trueforge
```

Open the printed URL (default `http://localhost:8790`), go to
**Settings → Models**, and add your model provider credentials.

### 2. Start the actions MCP server

```bash
npm run tools:dev
```

This starts a local MCP server on `http://localhost:8791/mcp` exposing
`send_email`, `create_support_ticket`, and `book_meeting`.

### 3. Register the connector in TrueForge

In the TrueForge UI, go to **Settings → Connectors → Add MCP server**, and
register:

- **Name:** `actions` (must match `ACTIONS_CONNECTOR_NAME` in
  [`src/agent/agentSpec.ts`](src/agent/agentSpec.ts))
- **URL:** `http://localhost:8791/mcp`
- **Auth:** none (local demo only)

### 4. Talk to the agent

```bash
npm run cli
```

Try:

```
> Email jane@example.com to confirm tomorrow's 3pm sync.
```

The CLI will print the drafted email and pause:

```
--- APPROVAL REQUIRED -----------------------------------
tool:      send_email
arguments: {
  "to": "jane@example.com",
  "subject": "Confirming tomorrow's 3pm sync",
  "body": "..."
}
-----------------------------------------------------------
Allow this action? [y/N]
```

Nothing is sent, filed, or booked until you type `y`. Type `n` (or anything
else) to deny, and the agent will ask what you'd like to do instead.

Optionally, run `npm run agent:register` to also save this agent to
TrueForge's Agents Library under the name `license-to-act`, so it's
selectable from the chat UI as well as the CLI.

## Project layout

```
src/
  agent/
    agentSpec.ts      Agent definition: model, instructions, approval gate
    registerAgent.ts  Optional: saves the agent to TrueForge's Agents Library
  tools/
    actions-mcp-server.ts  Custom MCP server: send_email, create_support_ticket, book_meeting
    store.ts                JSON-file "systems of record" + audit log
  cli.ts               Terminal client with the approval prompt loop
data/                  Gitignored. Created at runtime: outbox.json, tickets.json,
                        meetings.json, audit-log.json
```

## Notes on the mocked actions

`send_email`, `create_support_ticket`, and `book_meeting` write to local JSON
files instead of a real SMTP relay, ticketing system, or calendar API. That's
a deliberate demo choice — no personal accounts or credentials in this repo
or the demo video — not a limitation of the approval-gate mechanism. Swap the
body of `execute()` in `src/tools/actions-mcp-server.ts` for a real API call
and the approval gate around it keeps working unchanged.

## Qodo Code Review Evidence

Every substantive change in this repo lands via a pull request reviewed by
[Qodo](https://www.qodo.ai) before merge — no direct pushes to `main`.

- Representative reviewed PR: _link added once Qodo is connected and the
  first PR is reviewed — see [issue/PR tracker] for status._
- High-severity findings, if any, are fixed or documented here with a
  dismissal reason.

## License

MIT
