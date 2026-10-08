import type { Config } from "@netlify/functions";
import { sqlClient } from "./_lib/db";
import { env } from "./_lib/env";
import { digestBookingFromRow, sendBookingDigest } from "./_lib/mail";

function todayNz() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req: Request) => {
  if (env("BOOKING_DIGEST_ENABLED") === "false") {
    return json({ ok: true, skipped: true, reason: "BOOKING_DIGEST_ENABLED=false" });
  }

  let nextRun: string | undefined;
  try {
    const body = await req.json();
    nextRun = typeof body?.next_run === "string" ? body.next_run : undefined;
  } catch {
    /* manual invoke may send an empty body */
  }

  const sql = await sqlClient();
  if (!sql) {
    return json({ ok: false, error: "Database is not configured." }, 500);
  }

  const date = todayNz();
  const rows = await sql`
    SELECT kind, first_name, last_name, name, party_size, table_label,
           visit_time, notes, status
    FROM bookings
    WHERE visit_date = ${date}::date
      AND status IN ('pending', 'confirmed')
    ORDER BY visit_time ASC, created_at ASC
  `;

  const bookings = (rows as Record<string, unknown>[]).map(digestBookingFromRow);
  const mail = await sendBookingDigest(date, bookings);
  if (!mail.ok) {
    console.error("booking digest failed", date, mail.error);
    return json({ ok: false, date, count: bookings.length, error: mail.error }, 500);
  }

  console.log("booking digest sent", { date, count: bookings.length, nextRun });
  return json({ ok: true, date, count: bookings.length, nextRun });
};

// 17:00 UTC ≈ 6:00 am NZDT (Pacific/Auckland) on the same local calendar day.
export const config: Config = {
  schedule: "0 17 * * *",
};
