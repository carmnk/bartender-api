import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  timestamp: string;
  method?: string;
  url?: string;
  payload: unknown;
  status: number;
}

export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);

  // Always log to console.
  console.log(line);

  // Optionally append to a file.
  const filePath = process.env.AUDIT_LOG_FILE?.trim();

  if (!filePath) return;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line + "\n", "utf8");
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}