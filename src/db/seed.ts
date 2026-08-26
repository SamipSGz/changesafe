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
 * Usage: npm run db:seed  (safe to re-run -- deletes and recreates the file)
 */
import { existsSync, unlinkSync } from "node:fs";
import { DB_PATH, closeAll, writeDb } from "./client.js";

if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

const db = writeDb();

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
