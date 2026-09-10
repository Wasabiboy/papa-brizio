import type { Config } from "@netlify/functions";
import { sendGuestMessage, sendStaffAlert } from "./_lib/mail";
import { sqlClient } from "./_lib/db";
import { env } from "./_lib/env";
import { isValidSlot, settingsFromRow } from "./_lib/venue";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}(?:\s*(?:am|pm))?$/i;

type BookingKind = "table" | "hightea";

type BookingPayload = {
  kind?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  email?: string;
  partySize?: string;
  date?: string;
  time?: string;
  notes?: string;
};

function clip(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function guestName(payload: Required<Pick<BookingPayload, "firstName" | "lastName" | "name">>) {
  const full = [payload.firstName, payload.lastName].filter(Boolean).join(" ").trim();
  return full || payload.name;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "Use POST to send a booking." });
  }

  const resendKey = env("RESEND_API_KEY");
  const sql = await sqlClient();

  if (!sql) {
    return json(500, { error: "Bookings are not configured yet." });
  }
  if (!resendKey) {
    return json(500, { error: "Email sending is not configured yet." });
  }

  let body: BookingPayload;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Please complete the form and try again." });
  }

  const kind = clip(body.kind, 20) as BookingKind;
  if (kind !== "table" && kind !== "hightea") {
    return json(400, { error: "Unknown booking type." });
  }

  const firstName = clip(body.firstName, 80);
  const lastName = clip(body.lastName, 80);
  const name = clip(body.name, 120);
  const phone = clip(body.phone, 40);
  const email = clip(body.email, 120).toLowerCase();
  const partySize = clip(body.partySize, 32);
  const date = clip(body.date, 10);
  const time = clip(body.time, 20);
  const notes = clip(body.notes, 1000);
  const guest = guestName({ firstName, lastName, name });

  if (!guest || !phone || !email || !partySize || !date || !time) {
    return json(400, { error: "Please fill in all required fields." });
  }
  if (!EMAIL_RE.test(email)) {
    return json(400, { error: "Please enter a valid email address." });
  }
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return json(400, { error: "Please choose a valid date and time." });
  }

  try {
    const settingRows = await sql`SELECT timezone, slot_minutes, hours, closed_dates FROM venue_settings WHERE id = 'default' LIMIT 1`;
    const settings = settingsFromRow(settingRows[0] as Record<string, unknown> | undefined);
    if (!isValidSlot(settings, date, time)) {
      return json(400, { error: "That date or time isn't available. Please choose another." });
    }
  } catch (error) {
    console.error("hours check failed", error);
    return json(500, { error: "We couldn't check availability. Please call 09 478 9610." });
  }

  let bookingId = "";
  try {
    const rows = await sql`
      INSERT INTO bookings (
        kind, first_name, last_name, name, phone, email, party_size, visit_date, visit_time, notes
      ) VALUES (
        ${kind},
        ${firstName || null},
        ${lastName || null},
        ${name || guest},
        ${phone},
        ${email},
        ${partySize},
        ${date},
        ${time},
        ${notes || null}
      )
      RETURNING id
    `;
    bookingId = String(rows[0]?.id ?? "");
  } catch (error) {
    console.error("booking insert failed", error);
    return json(500, { error: "We couldn't save that request. Please call 09 478 9610." });
  }

  const mail = {
    kind,
    guest,
    phone,
    email,
    partySize,
    date,
    time,
    notes,
  };
  try {
    await sendStaffAlert(mail);
    const guestMail = await sendGuestMessage(mail, "request");
    if (!guestMail.ok) console.error("guest request email failed", guestMail.error);
  } catch (error) {
    console.error("booking email failed", error);
  }

  return json(201, {
    ok: true,
    id: bookingId,
    message: "We've emailed you. We'll confirm your booking shortly.",
  });
};

export const config: Config = {
  path: "/api/booking",
};
