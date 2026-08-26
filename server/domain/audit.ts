/**
 * Audit trail. Never store passwords, cookies, raw tokens, or email bodies.
 * `beforeJson` / `afterJson` must be redacted plain data.
 */
import { auditEvents } from "../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface AuditInput {
  /** e.g. "member:Alice", "admin", "system" */
  actorLabel: string;
  memberHint?: string | null;
  action: string; // e.g. "session.create", "member.deactivate", "dispute.open"
  entityType: string; // "session" | "member" | "dispute" | "join_request" | ...
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

export function writeAudit(db: Db, input: AuditInput): Promise<unknown> {
  return db.insert(auditEvents).values({
    actorLabel: input.actorLabel,
    memberHint: input.memberHint ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.beforeJson ?? null,
    afterJson: input.afterJson ?? null
  });
}
