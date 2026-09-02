import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer, verifyAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { golfRounds, members } from "../db/schema.js";
import { COURSE_PAR, GOLF_COURSES, suggestStrokeLine, weightedGolfStat } from "../domain/golf.js";
import type { GolfCourse, GolfRoundInput, WeightedGolfStat } from "../domain/golf.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import type { Ctx, Router } from "../router.js";
import { writeAudit } from "../domain/audit.js";

const courseSchema = z.enum(GOLF_COURSES);

const createSchema = z.object({
  memberId: z.string().uuid(),
  course: courseSchema,
  strokes: z.number().int().min(1).max(300),
  playedAt: z.string().datetime()
});

async function loadCourseRounds(course: GolfCourse) {
  return db
    .select({
      id: golfRounds.id,
      memberId: golfRounds.memberId,
      strokes: golfRounds.strokes,
      par: golfRounds.par,
      playedAt: golfRounds.playedAt
    })
    .from(golfRounds)
    .where(eq(golfRounds.course, course));
}

/** Groups rounds by memberId and runs the weighted-average calc for each active member. */
async function courseLeaderboard(course: GolfCourse) {
  const [rows, active] = await Promise.all([
    loadCourseRounds(course),
    db.select({ id: members.id, name: members.displayName }).from(members).where(eq(members.status, "active"))
  ]);
  const byMember = new Map<string, GolfRoundInput[]>();
  for (const r of rows) {
    const list = byMember.get(r.memberId) ?? [];
    list.push({ strokes: r.strokes, par: r.par, playedAt: r.playedAt });
    byMember.set(r.memberId, list);
  }
  return active
    .map((m) => ({ memberId: m.id, name: m.name, stat: weightedGolfStat(byMember.get(m.id) ?? []) }))
    .filter((r) => r.stat.roundsCount > 0)
    .sort((a, b) => (a.stat.value ?? 0) - (b.stat.value ?? 0));
}

export function registerGolfRoutes(router: Router): void {
  router.get("/api/poker/golf/rounds", async (ctx: Ctx) => {
    requireGroup(ctx);
    const rawCourse = ctx.query.get("course");
    const course = rawCourse !== null ? courseSchema.safeParse(rawCourse) : null;
    if (course && !course.success) throw badRequest("invalid_course", "Unknown course.");
    const rows = await db
      .select({
        id: golfRounds.id,
        memberId: golfRounds.memberId,
        name: members.displayName,
        course: golfRounds.course,
        strokes: golfRounds.strokes,
        par: golfRounds.par,
        playedAt: golfRounds.playedAt,
        recordedByMemberId: golfRounds.recordedByMemberId
      })
      .from(golfRounds)
      .innerJoin(members, eq(members.id, golfRounds.memberId))
      .where(course?.success ? eq(golfRounds.course, course.data) : undefined)
      .orderBy(desc(golfRounds.playedAt))
      .limit(300);
    return {
      rounds: rows.map((r) => ({
        id: r.id,
        memberId: r.memberId,
        name: r.name,
        course: r.course,
        strokes: r.strokes,
        par: r.par,
        toPar: r.strokes - r.par,
        playedAt: r.playedAt.toISOString(),
        recordedByMemberId: r.recordedByMemberId
      }))
    };
  });

  router.post("/api/poker/golf/rounds", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const body = createSchema.parse(ctx.body);
    const member = (await db.select({ id: members.id }).from(members).where(and(eq(members.id, body.memberId), eq(members.status, "active"))).limit(1))[0];
    if (!member) throw badRequest("invalid_member", "Choose an active member.");
    const id = randomUUID();
    const par = COURSE_PAR[body.course];
    await db.insert(golfRounds).values({
      id,
      memberId: body.memberId,
      course: body.course,
      strokes: body.strokes,
      par,
      playedAt: new Date(body.playedAt),
      recordedByMemberId: claims.mid
    });
    await writeAudit(db, {
      actorLabel: `member:${claims.mid}`,
      action: "golf_round.create",
      entityType: "golf_round",
      entityId: id,
      afterJson: { memberId: body.memberId, course: body.course, strokes: body.strokes, par }
    });
    return { created: true, id };
  });

  router.delete("/api/poker/golf/rounds/:id", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const roundId = ctx.params.id!;
    const existing = (await db.select().from(golfRounds).where(eq(golfRounds.id, roundId)).limit(1))[0];
    if (!existing) throw notFound();
    const isAdmin = Boolean(verifyAdmin(ctx.req));
    const isRecorder = existing.recordedByMemberId === claims.mid;
    if (!isAdmin && !isRecorder) {
      throw forbidden("Only the member who logged this round (or an admin) can delete it.");
    }
    await db.delete(golfRounds).where(eq(golfRounds.id, roundId));
    await writeAudit(db, {
      actorLabel: isAdmin ? "admin" : `member:${claims.mid}`,
      action: "golf_round.delete",
      entityType: "golf_round",
      entityId: roundId,
      beforeJson: { memberId: existing.memberId, course: existing.course, strokes: existing.strokes, par: existing.par }
    });
    return { ok: true };
  });

  router.get("/api/poker/golf/leaderboard", async (ctx: Ctx) => {
    requireGroup(ctx);
    const parsed = courseSchema.safeParse(ctx.query.get("course"));
    if (!parsed.success) throw badRequest("invalid_course", "Unknown course.");
    return { course: parsed.data, rows: await courseLeaderboard(parsed.data) };
  });

  router.get("/api/poker/golf/line", async (ctx: Ctx) => {
    requireGroup(ctx);
    const course = courseSchema.safeParse(ctx.query.get("course"));
    const memberA = ctx.query.get("a") ?? "";
    const memberB = ctx.query.get("b") ?? "";
    if (!course.success || !z.string().uuid().safeParse(memberA).success || !z.string().uuid().safeParse(memberB).success) {
      throw badRequest("invalid_request", "Provide a course and two member ids.");
    }
    if (memberA === memberB) throw badRequest("same_member", "Choose two different members.");
    const names = new Map(
      (await db.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, [memberA, memberB]))).map((m) => [m.id, m.name])
    );
    if (!names.has(memberA) || !names.has(memberB)) throw badRequest("invalid_member", "Choose active members only.");
    const rows = await loadCourseRounds(course.data);
    const roundsFor = (memberId: string): GolfRoundInput[] =>
      rows.filter((r) => r.memberId === memberId).map((r) => ({ strokes: r.strokes, par: r.par, playedAt: r.playedAt }));
    const statA: WeightedGolfStat = weightedGolfStat(roundsFor(memberA));
    const statB: WeightedGolfStat = weightedGolfStat(roundsFor(memberB));
    const line = suggestStrokeLine(statA, statB);
    return {
      course: course.data,
      a: { memberId: memberA, name: names.get(memberA), stat: statA },
      b: { memberId: memberB, name: names.get(memberB), stat: statB },
      line
    };
  });
}
