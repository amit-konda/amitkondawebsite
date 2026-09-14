import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyAdmin, clearCookie } from "../auth.js";
import { db } from "../db/client.js";
import { jobs, jobsMembers, members } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { JOB_TYPES, suggestJobMetadata } from "../jobs/suggest.js";
import type { Ctx, Router } from "../router.js";
import { JOBS_COOKIE, requireJobs, setJobsToken, verifyJobs, verifyJobsPassword } from "../jobs/auth.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
  company: z.string().trim().min(1).max(160),
  applicationUrl: z.url().max(2000).refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL."),
  jobType: z.enum(JOB_TYPES),
  description: z.string().trim().max(4000).optional(),
  applicationDeadline: z.string().date().optional()
});
const suggestSchema = z.object({ applicationUrl: z.url().max(2000).refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL.") });
const JOBS_ROSTER = ["Sahithi Myana", "Kyle Stamper", "Perri Parnell", "Aryan Saripella", "Maimuna Ilyas", "Maya Murali", "Simran Bajwa", "Esther Zhou", "James Gerhard", "Cara McMillan", "Yasemin Ciftci", "Juan Arratia", "Aidan Tacinelli", "Shaun Joseph", "Francisco Ardila", "Kartik Mathur", "Emily Tando", "Sua Lee", "Krrish Parekh", "Aadi Sharma", "Derrick Nguyen", "Emily Stamper", "David Ceglarz", "Diego Vares", "VJae Brown", "Edgar Rojas", "Nora Nazrul", "Andres Yengle", "Amit Konda", "Govind Pathathil", "Priyanka Parkar", "Shiv Jarodiya", "Roberta Torres"];

export function registerJobsRoutes(router: Router): void {
  router.get("/api/poker/jobs/auth/status", async (ctx) => {
    const claims = verifyJobs(ctx);
    return { authenticated: Boolean(claims), viewer: claims?.mid ?? null };
  });
  router.post("/api/poker/jobs/auth/login", async (ctx) => {
    const password = z.object({ password: z.string() }).parse(ctx.body).password;
    if (!verifyJobsPassword(password)) throw new (await import("../errors.js")).ApiError(401, "invalid_credentials", "Invalid jobs password.");
    setJobsToken(ctx, null);
    return { ok: true };
  });
  router.post("/api/poker/jobs/auth/logout", (ctx) => { clearCookie(ctx.res, JOBS_COOKIE); return { ok: true }; });
  router.get("/api/poker/jobs/members", async (ctx) => {
    requireJobs(ctx);
    for (const name of JOBS_ROSTER) await db.insert(jobsMembers).values({ name }).onConflictDoNothing();
    return { members: await db.select({ id: jobsMembers.id, name: jobsMembers.name }).from(jobsMembers).orderBy(jobsMembers.name) };
  });
  router.post("/api/poker/jobs/viewer", async (ctx) => {
    const claims = requireJobs(ctx);
    const body = z.object({ memberId: z.string().uuid() }).parse(ctx.body);
    const member = (await db.select({ id: jobsMembers.id }).from(jobsMembers).where(eq(jobsMembers.id, body.memberId)).limit(1))[0];
    if (!member) throw badRequest("invalid_member", "Choose an active member.");
    setJobsToken(ctx, member.id);
    return { viewer: { id: member.id } };
  });
  router.get("/api/poker/jobs", async (ctx) => {
    requireJobs(ctx);
    const showExpired = ctx.query.get("includeExpired") === "true";
    const rows = await db.select({
      id: jobs.id, title: jobs.title, company: jobs.company, applicationUrl: jobs.applicationUrl,
      jobType: jobs.jobType, description: jobs.description, applicationDeadline: jobs.applicationDeadline,
      createdAt: jobs.createdAt, submittedByJobsMemberId: jobs.submittedByJobsMemberId, submittedBy: jobsMembers.name
    }).from(jobs).innerJoin(jobsMembers, eq(jobsMembers.id, jobs.submittedByJobsMemberId))
      .orderBy(desc(jobs.createdAt)).limit(300);
    const now = new Date();
    return { jobs: rows.filter((job) => showExpired || !job.applicationDeadline || job.applicationDeadline >= now).map((job) => ({ ...job, applicationDeadline: job.applicationDeadline?.toISOString().slice(0, 10) ?? null, createdAt: job.createdAt.toISOString() })) };
  });

  router.post("/api/poker/jobs/suggest", async (ctx) => {
    requireJobs(ctx);
    const body = suggestSchema.safeParse(ctx.body);
    if (!body.success) throw badRequest("invalid_job", "Enter a valid application link.");
    return suggestJobMetadata(body.data.applicationUrl);
  });

  router.post("/api/poker/jobs", async (ctx) => {
    const claims = requireJobs(ctx);
    if (!claims.mid) throw badRequest("viewer_required", "Choose your name before posting.");
    const body = createSchema.safeParse(ctx.body);
    if (!body.success) throw badRequest("invalid_job", "Check the job details and try again.");
    const id = randomUUID();
    await db.insert(jobs).values({ id, title: body.data.title, company: body.data.company, applicationUrl: body.data.applicationUrl, jobType: body.data.jobType, description: body.data.description || null, applicationDeadline: body.data.applicationDeadline ? new Date(`${body.data.applicationDeadline}T23:59:59.999Z`) : null, submittedByJobsMemberId: claims.mid });
    await writeAudit(db, { actorLabel: `member:${claims.mid}`, action: "job.create", entityType: "job", entityId: id, afterJson: { title: body.data.title, company: body.data.company, jobType: body.data.jobType } });
    return { created: true, id };
  });

  router.delete("/api/poker/jobs/:id", async (ctx: Ctx) => {
    const claims = requireJobs(ctx);
    const existing = (await db.select().from(jobs).where(eq(jobs.id, ctx.params.id!)).limit(1))[0];
    if (!existing) throw notFound();
    const isAdmin = Boolean(verifyAdmin(ctx.req));
    if (!isAdmin && existing.submittedByJobsMemberId !== claims.mid) throw forbidden("Only the person who shared this job (or an admin) can remove it.");
    await db.delete(jobs).where(and(eq(jobs.id, existing.id), eq(jobs.submittedByJobsMemberId, existing.submittedByJobsMemberId)));
    await writeAudit(db, { actorLabel: isAdmin ? "admin" : `member:${claims.mid}`, action: "job.delete", entityType: "job", entityId: existing.id, beforeJson: { title: existing.title, company: existing.company } });
    return { ok: true };
  });
}
