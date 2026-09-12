import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { splitAuditEvents } from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export async function splitAudit(db: Db, input: {
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  requestKey?: string | null;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await db.insert(splitAuditEvents).values({
    actorUserId: input.actorUserId ?? null,
    actorLabel: input.actorLabel,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    requestKey: input.requestKey ?? null,
    beforeJson: input.before,
    afterJson: input.after
  });
}
