import type { Config } from "@netlify/functions";
import { neon } from "@neondatabase/serverless";
import { cookieHeader, isAuthed, makeToken, passwordOk } from "./_lib/auth";
import { env } from "./_lib/env";
import { sendGuestMessage, type BookingKind } from "./_lib/mail";
import { DEFAULT_SETTINGS, isOpenOnDate, normalizeSettings, settingsFromRow } from "./_lib/venue";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["pending", "confirmed", "cancelled", "completed"]);
const KINDS = new Set(["table", "hightea"]);

function json(status: number, body: Record<string, unknown>, req?: Request, token?: string | null) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (req && token !== undefined) {
    headers.set("set-cookie", cookieHeader(req, token || undefined));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function clip(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function todayNz() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sqlClient() {
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) return null;
  return neon(databaseUrl);
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/admin/session") {
    if (req.method === "GET") {
      return json(isAuthed(req) ? 200 : 401, { ok: isAuthed(req) });
    }
    if (req.method === "DELETE") {
      return json(200, { ok: true }, req, null);
    }
    if (req.method === "POST") {
      let body: { password?: string } = {};
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Enter the admin password." });
      }
      if (!passwordOk(String(body.password || ""))) {
        return json(401, { error: "Wrong password." });
      }
      return json(200, { ok: true }, req, makeToken());
    }
    return json(405, { error: "Unsupported method." });
  }

  if (!isAuthed(req)) {
    return json(401, { error: "Please sign in." });
  }

  const sql = sqlClient();
  if (!sql) {
    return json(500, { error: "Database is not configured." });
  }

  if (path === "/api/admin/hours") {
    if (req.method === "GET") {
      const rows = await sql`SELECT timezone, slot_minutes, hours, closed_dates FROM venue_settings WHERE id = 'default' LIMIT 1`;
      return json(200, settingsFromRow(rows[0] as Record<string, unknown> | undefined));
    }
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Invalid hours payload." });
      }
      const settings = normalizeSettings(body);
      const openDays = settings.hours.filter((day) => !day.closed);
      for (const day of openDays) {
        const start = day.open || "";
        const end = day.lastSlot || "";
        if (start >= end) {
          return json(400, { error: `${day.label}: last seating must be after opening time.` });
        }
      }
      await sql`
        INSERT INTO venue_settings (id, timezone, slot_minutes, hours, closed_dates, updated_at)
        VALUES (
          'default',
          ${settings.timezone},
          ${settings.slotMinutes},
          ${JSON.stringify(settings.hours)}::jsonb,
          ${JSON.stringify(settings.closedDates)}::jsonb,
          now()
        )
        ON CONFLICT (id) DO UPDATE SET
          timezone = EXCLUDED.timezone,
          slot_minutes = EXCLUDED.slot_minutes,
          hours = EXCLUDED.hours,
          closed_dates = EXCLUDED.closed_dates,
          updated_at = now()
      `;
      return json(200, { ok: true, ...settings });
    }
    return json(405, { error: "Unsupported method." });
  }

  if (path === "/api/admin/bookings") {
    if (req.method === "GET") {
      const from = DATE_RE.test(url.searchParams.get("from") || "") ? url.searchParams.get("from")! : todayNz();
      const to = DATE_RE.test(url.searchParams.get("to") || "") ? url.searchParams.get("to")! : null;
      const status = clip(url.searchParams.get("status"), 20) || "upcoming";
      const kind = clip(url.searchParams.get("kind"), 20);
      const rows = await sql`
        SELECT id, kind, first_name, last_name, name, phone, email, party_size, table_label,
               visit_date::text AS visit_date, visit_time, notes, status, created_at, updated_at
        FROM bookings
        WHERE visit_date >= ${from}
          AND (${to}::date IS NULL OR visit_date <= ${to}::date)
          AND (
            ${status} = 'all'
            OR (${status} = 'upcoming' AND status IN ('pending', 'confirmed'))
            OR status = ${status}
          )
          AND (${kind} = '' OR ${kind} = 'all' OR kind = ${kind})
        ORDER BY visit_date ASC, visit_time ASC, created_at ASC
        LIMIT 300
      `;
      return json(200, { bookings: rows });
    }

    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Invalid booking payload." });
      }
      const id = clip(body.id, 80);
      if (!id) return json(400, { error: "Missing booking id." });

      const firstName = clip(body.firstName, 80);
      const lastName = clip(body.lastName, 80);
      const name = clip(body.name, 120);
      const phone = clip(body.phone, 40);
      const email = clip(body.email, 120).toLowerCase();
      const partySize = clip(body.partySize, 32);
      const date = clip(body.date, 10);
      const time = clip(body.time, 20);
      const notes = clip(body.notes, 1000);
      const tableLabel = clip(body.tableLabel, 40);
      const status = clip(body.status, 20) || "pending";
      const kind = clip(body.kind, 20) as BookingKind;
      const emailGuest = body.emailGuest === true;
      const guest = [firstName, lastName].filter(Boolean).join(" ").trim() || name;

      if (!guest || !phone || !email || !partySize || !date || !time) {
        return json(400, { error: "Please fill in all required fields." });
      }
      if (!EMAIL_RE.test(email) || !DATE_RE.test(date) || !STATUSES.has(status) || !KINDS.has(kind)) {
        return json(400, { error: "Please check the booking details." });
      }

      const settingRows = await sql`SELECT timezone, slot_minutes, hours, closed_dates FROM venue_settings WHERE id = 'default' LIMIT 1`;
      const settings = settingsFromRow(settingRows[0] as Record<string, unknown> | undefined) || DEFAULT_SETTINGS;
      if (status !== "cancelled" && !isOpenOnDate(settings, date)) {
        return json(400, { error: "That date is marked closed in Hours. Open the day, choose another date, or cancel." });
      }

      const rows = await sql`
        UPDATE bookings SET
          kind = ${kind},
          first_name = ${firstName || null},
          last_name = ${lastName || null},
          name = ${name || guest},
          phone = ${phone},
          email = ${email},
          party_size = ${partySize},
          visit_date = ${date},
          visit_time = ${time},
          notes = ${notes || null},
          table_label = ${tableLabel || null},
          status = ${status},
          updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING id, kind, first_name, last_name, name, phone, email, party_size, table_label,
                  visit_date::text AS visit_date, visit_time, notes, status, created_at, updated_at
      `;
      if (!rows[0]) return json(404, { error: "Booking not found." });

      let emailed = false;
      if (emailGuest && status === "confirmed") {
        const mail = await sendGuestMessage({
          kind,
          guest,
          phone,
          email,
          partySize,
          date,
          time,
          notes,
          tableLabel,
        }, "confirmed");
        if (!mail.ok) {
          return json(200, {
            ok: true,
            booking: rows[0],
            warning: "Saved, but the guest email could not be sent. Check Resend or try again.",
          });
        }
        emailed = true;
      }

      return json(200, { ok: true, booking: rows[0], emailed });
    }
    return json(405, { error: "Unsupported method." });
  }

  return json(404, { error: "Not found." });
};

export const config: Config = {
  path: ["/api/admin/session", "/api/admin/bookings", "/api/admin/hours"],
};
