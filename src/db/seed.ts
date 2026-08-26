/**
 * Resets and seeds the demo database with deliberate duplicate customers.
 *
 * The two duplicate groups are asymmetric on purpose:
 *   - Alice's duplicate (customer 2) has an ACTIVE order -> merging it away
 *     is genuinely risky, and preview_change will flag it.
 *   - Carol's duplicates (customers 5 and 6) have no active orders -> a
 *     clean, low-risk merge.
 *
 * That asymmetry is what lets the demo show a real deny -> narrower
 * replan -> approve sequence driven by actual data, not a script.
 *
 * Resets rows IN PLACE (DELETE + re-INSERT inside a transaction) rather
 * than deleting and recreating the database file. If this unlinked the
 * file while a `npm run tools:dev` process still had it open, that process
 * would keep writing to the now-detached old file (on Unix) or the unlink
 * could fail outright (on platforms that lock open files) -- either way
 * the two processes would silently disagree about what the data is.
 * Resetting in place avoids that regardless of what else has the file open.
 *
 * Usage: npm run db:seed. Best run between demo takes, not while a
 * commit_change/rollback_change call is actually in flight elsewhere.
 */
import { DB_PATH, writeDb, closeAll } from "./client.js";

const db = writeDb();

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const resetTables = db.transaction(() => {
  db.exec("DELETE FROM change_log");
  db.exec("DELETE FROM support_tickets");
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM customers");
  // sqlite_sequence only exists once something has been inserted into an
  // AUTOINCREMENT table at least once -- guard for a truly fresh database.
  if (tableExists("sqlite_sequence")) {
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('orders', 'support_tickets')");
  }
});
resetTables();

const insertCustomer = db.prepare(
  "INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)",
);
const insertOrder = db.prepare(
  "INSERT INTO orders (customer_id, amount_cents, status, created_at) VALUES (?, ?, ?, ?)",
);
const insertTicket = db.prepare(
  "INSERT INTO support_tickets (customer_id, subject, status, created_at) VALUES (?, ?, ?, ?)",
);

const now = "2026-08-20T09:00:00.000Z";

const seed = db.transaction(() => {
  // 1-2: Alice duplicate group -- customer 2 has an ACTIVE order (risky merge)
  insertCustomer.run(1, "Alice Johnson", "alice@example.com", now);
  insertCustomer.run(2, "Alice Johnson", "alice@example.com", now);
  // 3: unrelated customer, not a duplicate of anyone
  insertCustomer.run(3, "Bob Smith", "bob@example.com", now);
  // 4-6: Carol 3-way duplicate group -- no active orders (clean merge)
  insertCustomer.run(4, "Carol Lee", "carol@example.com", now);
  insertCustomer.run(5, "Carol Lee", "carol@example.com", now);
  insertCustomer.run(6, "Carol L.", "carol@example.com", now);
  // 7-10: unrelated customers
  insertCustomer.run(7, "Dave Kim", "dave@example.com", now);
  insertCustomer.run(8, "Eve Chen", "eve@example.com", now);
  insertCustomer.run(9, "Frank Wu", "frank@example.com", now);
  insertCustomer.run(10, "Grace Park", "grace@example.com", now);

  insertOrder.run(1, 4200, "completed", now);
  insertOrder.run(1, 1500, "completed", now);
  insertOrder.run(2, 9900, "active", now); // <-- makes merging 1+2 risky
  insertOrder.run(2, 3000, "completed", now);
  insertOrder.run(3, 2200, "completed", now);
  insertOrder.run(4, 1000, "completed", now);
  insertOrder.run(4, 1200, "completed", now);
  insertOrder.run(4, 800, "completed", now);
  insertOrder.run(5, 1600, "completed", now);
  insertOrder.run(6, 500, "cancelled", now);
  insertOrder.run(7, 7700, "active", now); // unrelated active order, not part of any merge
  insertOrder.run(8, 2100, "completed", now);
  insertOrder.run(8, 3300, "completed", now);
  insertOrder.run(10, 4400, "completed", now);

  insertTicket.run(1, "Where is my order?", "closed", now);
  insertTicket.run(2, "Billing question", "open", now);
  insertTicket.run(4, "Refund request", "closed", now);
  insertTicket.run(5, "Can't log in", "open", now);
});

seed();
closeAll();

console.log(`Seeded ${DB_PATH}`);
console.log("Duplicate groups:");
console.log("  Alice Johnson <alice@example.com>: customers 1, 2 (2 has an ACTIVE order -- risky merge)");
console.log("  Carol Lee/L.  <carol@example.com>: customers 4, 5, 6 (no active orders -- clean merge)");
