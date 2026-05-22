import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { deadlines, notifications, states } from "@/lib/db/schema";
import { eq, and, gte, desc, sql } from "drizzle-orm";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const changes: Array<{
      id: string;
      type: string;
      title: string;
      description: string;
      actionUrl?: string;
      icon: string;
    }> = [];

    // 1. New deadlines in next 30 days
    const thirtyDaysOut = new Date();
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
    const today = new Date().toISOString().split("T")[0];

    const upcomingDeadlines = await db
      .select({
        id: deadlines.id,
        title: deadlines.title,
        deadlineDate: deadlines.deadlineDate,
        deadlineType: deadlines.deadlineType,
        stateCode: states.code,
      })
      .from(deadlines)
      .innerJoin(states, eq(deadlines.stateId, states.id))
      .where(
        and(
          gte(deadlines.deadlineDate, today!),
          sql`${deadlines.deadlineDate} <= ${thirtyDaysOut.toISOString().split("T")[0]}`
        )
      )
      .orderBy(deadlines.deadlineDate)
      .limit(5);

    for (const d of upcomingDeadlines) {
      const daysUntil = Math.ceil(
        (new Date(d.deadlineDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      );
      // Deadline titles already begin with the state code (e.g. "WY Elk
      // Nonresident Draw Results"), so only prepend the state code when
      // it's missing — avoids "WY WY ..." double-prefix on the dashboard.
      const titleHasState =
        d.stateCode && d.title.startsWith(`${d.stateCode} `);
      const displayTitle = titleHasState
        ? d.title
        : `${d.stateCode} ${d.title}`.trim();
      changes.push({
        id: `deadline-${d.id}`,
        type: daysUntil <= 7 ? "deadline_soon" : "deadline_new",
        title: displayTitle,
        description: `${d.deadlineType} deadline in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}`,
        actionUrl: "/calendar",
        icon: "deadline",
      });
    }

    // 2. Unread notifications (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentNotifs = await db
      .select({ id: notifications.id, title: notifications.title, body: notifications.body, type: notifications.type })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, session.user.id),
          eq(notifications.read, false),
          gte(notifications.createdAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(3);

    for (const n of recentNotifs) {
      changes.push({
        id: `notif-${n.id}`,
        type: n.type,
        title: n.title,
        description: n.body,
        icon: n.type === "point_creep" ? "trend_up" : "refresh",
      });
    }

    return NextResponse.json({ changes });
  } catch (error) {
    console.error("[dashboard/changes] Error:", error);
    return NextResponse.json({ changes: [] });
  }
}
