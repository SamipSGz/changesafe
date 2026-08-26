# ChangeSafe

An AI database operator built on [TrueForge](https://trueforge.dev) for
the [Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
("Give AI models a License to act").

ChangeSafe investigates a production-like customer database on its own —
finding duplicate customer records, computing exactly what merging them
would affect — but it can only ever delete a row through one narrow path,
and that path stops for a human before it runs. The prompt asks for
restraint; TrueForge enforces it.

## The pitch in one exchange

```
> Find any duplicate customers and tell me what merging them would affect.

[agent investigates via query_readonly, finds two duplicate groups]

I found two duplicate groups:
  - Alice Johnson (customers 1, 2)
  - Carol Lee/L.  (customers 4, 5, 6)

Previewing a merge of the Alice group (keep 1, remove 2):
  -> 2 orders reassigned, 1 STILL ACTIVE, 1 ticket reassigned, 1 customer deleted
  -> risk: HIGH (an active order would move mid-flight)

--- APPROVAL REQUIRED -----------------------------------
tool:      commit_change
arguments: { "change_id": "d6e4e297-..." }
-----------------------------------------------------------
Allow this action? [y/N] n

> Only merge duplicates with no active orders.

Previewing a merge of the Carol group (keep 4, remove 5, 6):
  -> 2 orders reassigned, 0 active, 1 ticket reassigned, 2 customers deleted
  -> risk: LOW

--- APPROVAL REQUIRED -----------------------------------
tool:      commit_change
arguments: { "change_id": "db39d286-..." }
-----------------------------------------------------------
Allow this action? [y/N] y

Change db39d286-... committed: 2 customers deleted, 2 orders and 1 ticket
reassigned to customer 4. Call rollback_change with this change_id to undo.
```

Everything above is real, not scripted output — the Alice group genuinely
has an active order in the seed data (see `src/db/seed.ts`), so previewing
it genuinely comes back HIGH risk; the Carol group genuinely doesn't.

## Why this project

The hackathon's judging weighs "Control and safety" as one of six equal
factors, and the organizers' own guidance says winning Double-O
submissions show "real MCP tools, sandboxed code execution, human
approvals, subagents, and persistent sessions" — not a chat interface with
one gated write tool bolted on. ChangeSafe is built around that bar
directly:

- **Real MCP tools, not mocked ones.** `db-mcp-server.ts` talks to an
  actual SQLite database with real foreign keys, real transactions, and
  real constraints. A merge really deletes rows; a rollback really
  restores them.
- **Autonomy for observation, friction for mutation.** Four of the five
  tools (`inspect_schema`, `query_readonly`, `preview_change`,
  `rollback_change`) run with no approval at all. Only `commit_change` —
  the one tool that permanently deletes customer rows — is gated.
- **The gate can't be bypassed by generation.** TrueForge's Code Mode
  still enforces `require_approval_for_tools` even when a tool call
  originates from a script the agent wrote and ran in its own sandbox —
  the model can't route around governance by generating code instead of
  calling a tool directly.
- **Approval is for an exact, already-computed plan.** `commit_change`
  accepts *only* a `change_id` — never fresh parameters. Whatever a human
  reviewed in `preview_change`'s manifest is exactly what executes; there
  is no way for a later call to smuggle in a bigger action under an
  approval that was granted for a smaller one.
- **Persistent sessions.** The CLI saves its session id to disk and
  resumes it on the next run — kill the process mid-conversation, even
  mid-approval-pause, and restart it; the agent picks up with full
  context intact.

## Architecture

```
┌──────────────┐   user message    ┌─────────────┐   commit_change    ┌───────────────────┐
│  src/cli.ts  │ ─────────────────▶│  TrueForge  │────────────────────▶│  db MCP server    │
│ (terminal    │                   │   server    │   (needs approval)  │ (src/tools/)       │
│  client,     │◀───────────────── │  (harness)  │                     │                    │
│  resumable   │  approval_required│             │  inspect_schema,    │  inspect_schema    │
│  session)    │                   │             │  query_readonly,    │  query_readonly    │
└──────────────┘        │          │             │  preview_change,    │  preview_change    │
       │                │          │             │  rollback_change    │  commit_change      │
       │  human types    │         └──────┬──────┘  (no approval)      │  rollback_change    │
       │  y/n            │                │                            └─────────┬──────────┘
       └─────────────────┘                │ sandbox / Code Mode                  │
                                           ▼ (script calls MCP tools,             ▼
                                     still approval-gated)              data/changesafe.db
                                                                         (SQLite, real FKs
                                                                          + transactions)
```

- **TrueForge** runs the agent loop, decides which tool calls need
  approval (`commit_change` only), and streams every step back to the
  client. With `config.sandbox.enabled: true`, it can also run agent-
  generated Python in an isolated sandbox (Code Mode) that calls back into
  these same MCP tools under the same approval policy.
- **`src/tools/db-mcp-server.ts`** is a custom MCP server exposing five
  tools over Streamable HTTP. It never decides whether it's allowed to run
  — by the time `commit_change`'s handler executes, a human has already
  approved that specific `change_id` upstream in TrueForge.
- **`src/db/`** is the database layer: schema, a deterministic seed
  script, the merge/rollback operation logic (pure, unit-testable-by-hand
  functions), and a small `change_log` table that records every preview,
  commit, and rollback.
- **`src/cli.ts`** is a terminal client using `@truefoundry/trueforge-sdk`.
  It streams the agent's turns, prints the full tool name and arguments on
  every `tool.approval_required` event, and persists/resumes its session
  id across runs.

### Why SQLite instead of Postgres

A "production-like" database doesn't have to mean a separate server. This
repo stays true to the README's own bar — a stranger can clone it and run
it, no Docker, no hosted DB, no connection string — while still being a
real SQL engine with real transactions, foreign keys, and constraints. The
blast-radius and rollback logic in `mergeOperation.ts` is not a
simulation; swap `src/db/client.ts` for a Postgres connection and the rest
of the logic is largely unchanged.

## Setup

Prerequisites: Node.js 22+ (required by `@truefoundry/trueforge-sdk`), and
your own API key for a model provider (OpenAI, Anthropic, Gemini, or any
OpenAI-compatible endpoint).

```bash
git clone https://github.com/SamipSGz/changesafe.git
cd changesafe
npm install
cp .env.example .env
npm run db:seed
```

### 1. Start TrueForge

```bash
npx @truefoundry/trueforge
```

Open the printed URL (default `http://localhost:8790`), go to
**Settings → Models**, and add your model provider credentials.

### 2. Start the db MCP server

```bash
npm run tools:dev
```

Starts a local MCP server on `http://localhost:8791/mcp` exposing
`inspect_schema`, `query_readonly`, `preview_change`, `commit_change`, and
`rollback_change`.

### 3. Register the connector in TrueForge

**Settings → Connectors → Add MCP server**:

- **Name:** `db` (must match `DB_CONNECTOR_NAME` in
  [`src/agent/agentSpec.ts`](src/agent/agentSpec.ts))
- **URL:** `http://localhost:8791/mcp`
- **Auth:** none (local demo only)

### 4. Talk to the agent

```bash
npm run cli
```

Try:

```
> Find any duplicate customers and tell me what merging them would affect.
```

Nothing is deleted until you approve a `commit_change` call. Kill the CLI
mid-conversation and run `npm run cli` again — it resumes the same
session instead of starting over.

To reset the demo data back to its original state at any point:
`npm run db:seed` (resets rows in place; safe to run between demo takes,
just not concurrently with an in-flight `commit_change`/`rollback_change`
call elsewhere).

## Project layout

```
src/
  agent/
    agentSpec.ts        Agent definition: model, instructions, approval gate,
                         sandbox + subagent config
  db/
    schema.sql           Table definitions (customers, orders,
                          support_tickets, change_log)
    client.ts            SQLite connection management (separate read-only
                          and read/write handles -- see below)
    seed.ts               Deterministic demo data with two duplicate groups
    mergeOperation.ts     Pure preview / apply / undo logic for merges
    changeLog.ts           change_log table read/write helpers
  tools/
    db-mcp-server.ts       Custom MCP server: the five tools
  cli.ts                 Terminal client with the approval prompt loop and
                          session persistence
data/                    Gitignored. Created at runtime: changesafe.db, session.json
```

## Design notes worth reading before you review the code

- **Two SQLite connections, on purpose.** `query_readonly` runs on a
  connection SQLite itself opened as `readonly: true` — it cannot execute
  a write no matter what SQL text an agent (or a bug) hands it, on top of
  a string-based guard as defense in depth. `preview_change` never issues
  anything but `SELECT`. Only `commit_change` and `rollback_change` use
  the read/write connection, and both wrap their mutations in an explicit
  transaction.
- **Only one operation type is implemented** (`merge_duplicate_customers`)
  rather than a generic "run arbitrary mutating SQL" tool. A general
  destructive-SQL tool is a much larger and riskier surface than a few
  days should take on; one well-tested, fully reversible operation beats
  a broad one that's only approximately safe.
- **`rollback_change` is not approval-gated.** Undoing an already-approved
  change is treated as safe and recoverable, not as a new risk — we don't
  gate the undo button.
- **Subagents and Code Mode are harness capabilities we configure and
  prompt for, not code we hand-wrote.** `config.sandbox.enabled` and
  `config.dynamic_sub_agents.enabled` are on, and `agentSpec.ts`'s
  instructions actively encourage the model to delegate analysis to
  subagents and to compute reports via a sandboxed script. Whether either
  actually fires on a given run is the model's runtime decision, not
  something this repo hardcodes — that's an honest characterization, not
  a guarantee.

## Qodo Code Review Evidence

Every substantive change in this repo lands via a pull request reviewed by
[Qodo](https://www.qodo.ai) before merge — no direct pushes to `main`.

- **PR #1** (initial TrueForge scaffold, later evolved into ChangeSafe):
  [#1 — Scaffold approval-gated action assistant on TrueForge](https://github.com/SamipSGz/changesafe/pull/1),
  merged after 5 findings (2 "Action required") were all fixed — see the
  fix table preserved in that PR's description and review thread.
- **PR #2** (ChangeSafe rewrite):
  [#2 — Pivot to ChangeSafe: an AI database operator on TrueForge](https://github.com/SamipSGz/changesafe/pull/2)
  ([Qodo's review comment](https://github.com/SamipSGz/changesafe/pull/2#issuecomment-5421086444)),
  8 findings (3 "Action required"), all fixed:

  | # | Finding | Severity | Resolution |
  |---|---------|----------|------------|
  | 1 | `commit_change` trusted the stored preview manifest without recomputing it, so an overlapping approved change could make a commit affect more rows than what was actually reviewed | Action required | **Fixed** — `commit_change` now recomputes the manifest from current data inside the same transaction and refuses to proceed if it differs from what was approved |
  | 2 | `rollback_change` restored ownership from a stale snapshot with no check for later changes, corrupting state if overlapping merges were rolled back out of order | Action required | **Fixed** — added `assertUndoIsSafe`, which refuses a rollback if a later change already moved the same rows again |
  | 3 | The merge tool only checked that customer ids existed, not that they were actually duplicates — any two customers could be merged | Action required / Security | **Fixed** — `validateParams` now requires every removed customer's normalized email to match the kept customer's |
  | 4 | `npm run db:seed` deleted and recreated the database file, which could split state from a running MCP server's already-open connection | Action required | **Fixed** — reseeding now resets rows in place (DELETE + re-INSERT in a transaction) instead of touching the file; verified live against a running server |
  | 5 | Session persistence saved only the session id — restarting mid-approval-pause didn't actually recover the pending approval, contradicting what the README claimed | Action required | **Fixed** — on resume, the CLI now finds the latest turn, and if it's paused on an approval, rebuilds the event index and pending approvals before accepting new input |
  | 6 | `query_readonly` called `.all()` before slicing to 200 rows, so a huge result or cross join fully materialized in memory first | Review recommended | **Fixed** — switched to `.iterate()` and stops after 200 rows; verified a 10-billion-row theoretical cross join returns in ~30ms |
  | 7 | The read-only guard rejected valid `WITH ...` CTE queries because it only accepted a leading `SELECT` | Review recommended | **Fixed** — guard now accepts `WITH` or `SELECT`; the real enforcement (the physically read-only SQLite connection) was never affected |
  | 8 | The write-keyword guard scanned raw SQL text, so a literal like `WHERE subject = 'DELETE my account'` was falsely rejected | Review recommended | **Fixed** — string literals are stripped before the keyword scan |

  All 8 fixes were verified against a running instance of the MCP server
  (not just read), including deliberately constructing the exact
  overlapping-merge scenarios findings #1 and #2 describe and confirming
  both the failure is now blocked and the correct order still succeeds.

## License

MIT
