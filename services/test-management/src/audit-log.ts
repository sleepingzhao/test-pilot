import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AuditEvent = {
  at: string;
  action: "test.approve";
  testId: string;
  title: string;
  actor: string;
  irHash: string;
  assertionConfigHash: string;
};

export async function appendAuditEvent(dataRoot: string, event: AuditEvent): Promise<void> {
  await appendFile(join(dataRoot, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readAuditLog(dataRoot: string, limit = 50): Promise<AuditEvent[]> {
  const cap = Math.min(Math.max(1, limit), 200);
  let raw: string;
  try {
    raw = await readFile(join(dataRoot, "audit.jsonl"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter(Boolean);
  const tail = lines.slice(-cap);
  const parsed: AuditEvent[] = [];
  for (const line of tail) {
    try {
      parsed.push(JSON.parse(line) as AuditEvent);
    } catch {
      /* skip corrupt lines */
    }
  }
  return parsed.reverse();
}
