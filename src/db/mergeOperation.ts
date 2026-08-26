/**
 * The one operation ChangeSafe knows how to preview/commit/rollback:
 * merging duplicate customer records (reassign their orders and support
 * tickets onto a canonical customer, then delete the duplicates).
 *
 * Deliberately scoped to ONE well-tested operation rather than a generic
 * "run arbitrary mutating SQL" tool -- that keeps the blast-radius and
 * rollback logic correct and auditable instead of trying to safely
 * generalize destructive SQL, which is a much larger and riskier surface
 * than a 4-day build should take on.
 */
import type Database from "better-sqlite3";

export interface MergeParams {
  keepId: number;
  removeIds: number[];
}

export interface CustomerRow {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export interface MergeManifest {
  operation: "merge_duplicate_customers";
  keepCustomer: CustomerRow;
  removeCustomers: CustomerRow[];
  ordersReassigned: number;
  activeOrdersAffected: number;
  ticketsReassigned: number;
  customersDeleted: number;
  risk: "low" | "high";
  riskReason: string;
}

/** Everything needed to exactly reverse a committed merge. */
export interface MergeUndoSnapshot {
  removedCustomers: CustomerRow[];
  reassignedOrders: { id: number; originalCustomerId: number }[];
  reassignedTickets: { id: number; originalCustomerId: number }[];
}

function validateParams(db: Database.Database, params: MergeParams): void {
  if (params.removeIds.length === 0) {
    throw new Error("removeIds must contain at least one customer id");
  }
  if (params.removeIds.includes(params.keepId)) {
    throw new Error("keepId cannot also appear in removeIds");
  }
  const ids = [params.keepId, ...params.removeIds];
  const placeholders = ids.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id FROM customers WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number }[];
  const foundIds = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(`No such customer id(s): ${missing.join(", ")}`);
  }
}

/** Pure read-only computation -- issues only SELECT statements. Safe to
 * call as many times as you like; never mutates anything. */
export function computeMergeManifest(db: Database.Database, params: MergeParams): MergeManifest {
  validateParams(db, params);

  const keepCustomer = db
    .prepare("SELECT id, name, email, created_at FROM customers WHERE id = ?")
    .get(params.keepId) as CustomerRow;

  const placeholders = params.removeIds.map(() => "?").join(",");
  const removeCustomers = db
    .prepare(`SELECT id, name, email, created_at FROM customers WHERE id IN (${placeholders})`)
    .all(...params.removeIds) as CustomerRow[];

  const orderStats = db
    .prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
       FROM orders WHERE customer_id IN (${placeholders})`,
    )
    .get(...params.removeIds) as { total: number; active: number | null };

  const ticketStats = db
    .prepare(`SELECT COUNT(*) as total FROM support_tickets WHERE customer_id IN (${placeholders})`)
    .get(...params.removeIds) as { total: number };

  const activeOrdersAffected = orderStats.active ?? 0;
  const risk: MergeManifest["risk"] = activeOrdersAffected > 0 ? "high" : "low";
  const riskReason =
    activeOrdersAffected > 0
      ? `${activeOrdersAffected} of the affected order(s) are still ACTIVE -- reassigning them mid-flight is risky`
      : "no active orders are affected by this merge";

  return {
    operation: "merge_duplicate_customers",
    keepCustomer,
    removeCustomers,
    ordersReassigned: orderStats.total,
    activeOrdersAffected,
    ticketsReassigned: ticketStats.total,
    customersDeleted: removeCustomers.length,
    risk,
    riskReason,
  };
}

/** Actually performs the merge. Must run inside a transaction the caller
 * controls (see db-mcp-server.ts commit_change). Captures a full undo
 * snapshot BEFORE mutating anything, so rollback_change can exactly
 * reverse this call later. */
export function applyMerge(db: Database.Database, params: MergeParams): MergeUndoSnapshot {
  validateParams(db, params);
  const placeholders = params.removeIds.map(() => "?").join(",");

  const removedCustomers = db
    .prepare(`SELECT id, name, email, created_at FROM customers WHERE id IN (${placeholders})`)
    .all(...params.removeIds) as CustomerRow[];

  const affectedOrders = db
    .prepare(`SELECT id, customer_id FROM orders WHERE customer_id IN (${placeholders})`)
    .all(...params.removeIds) as { id: number; customer_id: number }[];

  const affectedTickets = db
    .prepare(`SELECT id, customer_id FROM support_tickets WHERE customer_id IN (${placeholders})`)
    .all(...params.removeIds) as { id: number; customer_id: number }[];

  db.prepare(`UPDATE orders SET customer_id = ? WHERE customer_id IN (${placeholders})`).run(
    params.keepId,
    ...params.removeIds,
  );
  db.prepare(`UPDATE support_tickets SET customer_id = ? WHERE customer_id IN (${placeholders})`).run(
    params.keepId,
    ...params.removeIds,
  );
  db.prepare(`DELETE FROM customers WHERE id IN (${placeholders})`).run(...params.removeIds);

  return {
    removedCustomers,
    reassignedOrders: affectedOrders.map((o) => ({ id: o.id, originalCustomerId: o.customer_id })),
    reassignedTickets: affectedTickets.map((t) => ({ id: t.id, originalCustomerId: t.customer_id })),
  };
}

/** Reverses applyMerge exactly, using the undo snapshot captured at commit
 * time. Must also run inside a transaction the caller controls. */
export function undoMerge(db: Database.Database, snapshot: MergeUndoSnapshot): void {
  for (const c of snapshot.removedCustomers) {
    db.prepare("INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)").run(
      c.id,
      c.name,
      c.email,
      c.created_at,
    );
  }
  const updateOrder = db.prepare("UPDATE orders SET customer_id = ? WHERE id = ?");
  for (const o of snapshot.reassignedOrders) {
    updateOrder.run(o.originalCustomerId, o.id);
  }
  const updateTicket = db.prepare("UPDATE support_tickets SET customer_id = ? WHERE id = ?");
  for (const t of snapshot.reassignedTickets) {
    updateTicket.run(t.originalCustomerId, t.id);
  }
}
