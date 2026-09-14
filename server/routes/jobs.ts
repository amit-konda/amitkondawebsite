import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer, verifyAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { jobs, members } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { JOB_TYPES, suggestJobMetadata } from "../jobs/suggest.js";
import type { Ctx, Router } from "../router.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
  company: z.string().trim().min(1).max(160),
  applicationUrl: z.url().max(2000).refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL."),
  jobType: z.enum(JOB_TYPES),
  description: z.string().trim().max(4000).optional(),
  applicationDeadline: z.string().date().optional()
});
const suggestSchema = z.object({ applicationUrl: z.url().max(2000).refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL.") });

export function registerJobsRoutes(router: Router): void {
  router.get("/api/poker/jobs", async (ctx) => {
    requireGroup(ctx);
    const showExpired = ctx.query.get("includeExpired") === "true";
    const rows = await db.select({
      id: jobs.id, title: jobs.title, company: jobs.company, applicationUrl: jobs.applicationUrl,
      jobType: jobs.jobType, description: jobs.description, applicationDeadline: jobs.applicationDeadline,
      createdAt: jobs.createdAt, submittedByMemberId: jobs.submittedByMemberId, submittedBy: members.displayName
    }).from(jobs).innerJoin(members, eq(members.id, jobs.submittedByMemberId))
      .orderBy(desc(jobs.createdAt)).limit(300);
    const now = new Date();
    return { jobs: rows.filter((job) => showExpired || !job.applicationDeadline || job.applicationDeadline >= now).map((job) => ({ ...job, applicationDeadline: job.applicationDeadline?.toISOString().slice(0, 10) ?? null, createdAt: job.createdAt.toISOString() })) };
  });

  router.post("/api/poker/jobs/suggest", async (ctx) => {
    requireGroup(ctx);
    const body = suggestSchema.safeParse(ctx.body);
    if (!body.success) throw badRequest("invalid_job", "Enter a valid application link.");
    return suggestJobMetadata(body.data.applicationUrl);
  });

  router.post("/api/poker/jobs", async (ctx) => {
    const claims = requireViewer(ctx);
    const body = createSchema.safeParse(ctx.body);
    if (!body.success) throw badRequest("invalid_job", "Check the job details and try again.");
    const id = randomUUID();
    await db.insert(jobs).values({ id, title: body.data.title, company: body.data.company, applicationUrl: body.data.applicationUrl, jobType: body.data.jobType, description: body.data.description || null, applicationDeadline: body.data.applicationDeadline ? new Date(`${body.data.applicationDeadline}T23:59:59.999Z`) : null, submittedByMemberId: claims.mid! });
    await writeAudit(db, { actorLabel: `member:${claims.mid}`, action: "job.create", entityType: "job", entityId: id, afterJson: { title: body.data.title, company: body.data.company, jobType: body.data.jobType } });
    return { created: true, id };
  });

  router.delete("/api/poker/jobs/:id", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const existing = (await db.select().from(jobs).where(eq(jobs.id, ctx.params.id!)).limit(1))[0];
    if (!existing) throw notFound();
    const isAdmin = Boolean(verifyAdmin(ctx.req));
    if (!isAdmin && existing.submittedByMemberId !== claims.mid) throw forbidden("Only the person who shared this job (or an admin) can remove it.");
    await db.delete(jobs).where(and(eq(jobs.id, existing.id), eq(jobs.submittedByMemberId, existing.submittedByMemberId)));
    await writeAudit(db, { actorLabel: isAdmin ? "admin" : `member:${claims.mid}`, action: "job.delete", entityType: "job", entityId: existing.id, beforeJson: { title: existing.title, company: existing.company } });
    return { ok: true };
  });
}
