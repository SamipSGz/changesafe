/**
 * Tiny JSON-file-backed "systems of record" for the demo.
 *
 * These stand in for the real, irreversible destinations an action would
 * normally hit (an SMTP relay, a ticketing system, a calendar API). Every
 * write here is only ever reached AFTER a human has approved the tool call
 * upstream in TrueForge -- see README.md "Control & Safety" section.
 *
 * Swap `execute()` in each tool (src/tools/actions-mcp-server.ts) for a real
 * API call when you're ready to point this at production systems. Keep the
 * approval gate either way.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function dataFile(name: string): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return join(DATA_DIR, name);
}

/** A missing file just means "no history yet" (fine). A file that exists
 * but fails to parse means something got corrupted or truncated -- treating
 * that the same as "empty" would let the very next write silently erase
 * whatever history survived, so it throws instead. */
function readJson<T>(name: string, fallback: T): T {
  const file = dataFile(name);
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf-8");
  if (raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Refusing to continue: ${file} exists but is not valid JSON (${(err as Error).message}). ` +
        "Fix or remove it by hand before writing again -- overwriting it automatically would " +
        "silently discard whatever history it still holds.",
    );
  }
}

/** Write via a temp file + rename so a crash mid-write can never leave a
 * half-written (and therefore unparsable-per-readJson) file behind. */
function writeJson<T>(name: string, value: T): void {
  const file = dataFile(name);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, file);
}

export interface AuditEntry {
  id: string;
  tool: string;
  args: unknown;
  result: unknown;
  timestamp: string;
}

export function appendAudit(entry: AuditEntry): void {
  const log = readJson<AuditEntry[]>("audit-log.json", []);
  log.push(entry);
  writeJson("audit-log.json", log);
}

export interface OutboxEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

export function saveEmail(email: OutboxEmail): void {
  const outbox = readJson<OutboxEmail[]>("outbox.json", []);
  outbox.push(email);
  writeJson("outbox.json", outbox);
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  createdAt: string;
}

export function saveTicket(ticket: Ticket): void {
  const tickets = readJson<Ticket[]>("tickets.json", []);
  tickets.push(ticket);
  writeJson("tickets.json", tickets);
}

export interface Meeting {
  id: string;
  title: string;
  attendees: string[];
  startTime: string;
  durationMinutes: number;
  createdAt: string;
}

export function saveMeeting(meeting: Meeting): void {
  const meetings = readJson<Meeting[]>("meetings.json", []);
  meetings.push(meeting);
  writeJson("meetings.json", meetings);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
