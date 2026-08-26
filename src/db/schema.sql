-- ChangeSafe demo schema: a small "production-like" customer database with
-- deliberate duplicate customer records, some of which have active orders
-- and some of which don't. That asymmetry is what makes the demo's
-- deny -> narrower replan -> approve sequence real instead of scripted:
-- merging the Alice group genuinely is riskier than merging the Carol
-- group, because Alice's duplicate has a still-active order.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  created_at  TEXT NOT NULL
);

-- Every preview and every commit is logged here. commit_change only ever
-- accepts a change_id (see src/tools/db-mcp-server.ts) -- never a fresh set
-- of parameters -- so whatever a human approved is exactly what executes,
-- with no way for a later call to swap in a bigger action under the same
-- approval.
CREATE TABLE IF NOT EXISTS change_log (
  id             TEXT PRIMARY KEY,
  operation      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('previewed', 'committed', 'rolled_back')),
  params         TEXT NOT NULL,   -- JSON: the exact operation parameters, fixed at preview time
  manifest       TEXT NOT NULL,   -- JSON: the computed blast-radius preview
  undo_snapshot  TEXT,            -- JSON: exact rows needed to reverse; set on commit
  created_at     TEXT NOT NULL,
  committed_at   TEXT,
  rolled_back_at TEXT
);
