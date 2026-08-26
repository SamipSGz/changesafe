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

Prerequisites: Node.js 22+ (required by `@truefoundry/trueforge-sdk`), and your own API key for a model provider
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

- Representative reviewed PR:
  [#1 — Scaffold approval-gated action assistant on TrueForge](https://github.com/SamipSGz/license-to-act/pull/1)
  ([Qodo's review comment](https://github.com/SamipSGz/license-to-act/pull/1#issuecomment-5420363280))
- Findings and how they were handled:

  | # | Finding | Severity | Resolution |
  |---|---------|----------|------------|
  | 1 | `actions-mcp-server.ts` bound to the wildcard interface, letting any network-reachable client bypass the TrueForge approval gate | Action required | **Fixed** — server now binds to `127.0.0.1` explicitly, with a comment explaining why it must stay that way |
  | 2 | README/CI advertised Node 20+, but `@truefoundry/trueforge-sdk` requires Node ≥22 | Action required | **Fixed** — README, `package.json` `engines`, and CI workflow all updated to Node 22 |
  | 3 | `book_meeting`'s `startTime` was documented as ISO-8601 but accepted any string | Review recommended | **Fixed** — added a Zod `refine` that rejects unparsable datetimes |
  | 4 | A corrupt/truncated JSON data file was silently treated as empty, so the next write would erase prior history | Review recommended | **Fixed** — reads now throw on a corrupt (vs. missing) file instead of discarding it, and writes go through a temp-file-plus-rename to avoid leaving a half-written file behind |
  | 5 | Each tool saved the action, then wrote the audit entry — an audit-write failure could leave an executed action with no audit record | Review recommended | **Fixed** — audit entries are now written *before* the corresponding save, so an audit failure aborts the action instead of an action succeeding invisibly. (Full transactional idempotency across retries is out of scope for this mocked, file-backed demo store — noted here rather than silently ignored.) |

All 5 findings were fixed, not dismissed; each fix was re-verified against a
running instance of the MCP server (loopback binding, rejected/accepted
`startTime` values, and the corrupt-file guard were all exercised by hand)
before this table was written.

## License

MIT
