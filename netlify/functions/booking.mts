import type { Config } from "@netlify/functions";
import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
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

function emailCopy(kind: BookingKind, data: {
  guest: string;
  phone: string;
  email: string;
  partySize: string;
  date: string;
  time: string;
  notes: string;
}) {
  const title = kind === "hightea" ? "High Tea booking" : "Table reservation";
  const lines = [
    `${title} request`,
    "",
    `Name: ${data.guest}`,
    `Phone: ${data.phone}`,
    `Email: ${data.email}`,
    `Party: ${data.partySize}`,
    `Date: ${data.date}`,
    `Time: ${data.time}`,
    `Notes: ${data.notes || "None"}`,
    "",
    "This request is pending confirmation.",
  ];
  const text = lines.join("\n");
  const html = `
    <div style="font-family:Georgia,serif;background:#14110f;color:#f5f0e8;padding:32px;">
      <p style="color:#c9a96e;letter-spacing:0.16em;text-transform:uppercase;font-size:12px;margin:0 0 8px;">Papà Brizio</p>
      <h1 style="font-weight:400;font-size:28px;margin:0 0 24px;">${escapeHtml(title)}</h1>
      <table style="border-collapse:collapse;font-size:16px;line-height:1.6;">
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Name</td><td>${escapeHtml(data.guest)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Phone</td><td>${escapeHtml(data.phone)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Email</td><td>${escapeHtml(data.email)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Party</td><td>${escapeHtml(data.partySize)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Date</td><td>${escapeHtml(data.date)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Time</td><td>${escapeHtml(data.time)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">Notes</td><td>${escapeHtml(data.notes || "None")}</td></tr>
      </table>
      <p style="margin:24px 0 0;color:#b9b0a4;font-size:14px;">This request is pending confirmation.</p>
    </div>
  `;
  return { title, text, html };
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "Use POST to send a booking." });
  }

  const databaseUrl = env("DATABASE_URL");
  const resendKey = env("RESEND_API_KEY");
  const notifyEmail = env("BOOKING_NOTIFY_EMAIL") || "montrosecafe@xtra.co.nz";
  const testEmail = env("BOOKING_TEST_EMAIL");
  const fromEmail = env("RESEND_FROM") || "Papa Brizio <onboarding@resend.dev>";

  if (!databaseUrl) {
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

  const sql = neon(databaseUrl);
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

  const copy = emailCopy(kind, {
    guest,
    phone,
    email,
    partySize,
    date,
    time,
    notes,
  });
  const resend = new Resend(resendKey);

  try {
    const staffTo = [...new Set([notifyEmail, testEmail].filter(Boolean))];
    for (const to of staffTo) {
      const staff = await resend.emails.send({
        from: fromEmail,
        to,
        replyTo: email,
        subject: `${copy.title} — ${guest}`,
        text: copy.text,
        html: copy.html,
      });
      if (staff.error) {
        console.error("staff email failed", to, staff.error);
      }
    }

    const guestMail = await resend.emails.send({
      from: fromEmail,
      to: email,
      replyTo: notifyEmail,
      subject: `We received your ${copy.title.toLowerCase()} request`,
      text: [
        `Kia ora ${guest},`,
        "",
        "Thanks for your request at Papà Brizio, 1 Montrose Terrace, Mairangi Bay.",
        "",
        copy.text,
        "",
        "We'll confirm by phone or email shortly.",
        "If you need to change anything, call 09 478 9610.",
      ].join("\n"),
      html: `${copy.html}<p style="font-family:Georgia,serif;color:#b9b0a4;padding:0 32px 32px;margin:0;">We'll confirm by phone or email shortly. Call 09 478 9610 if you need to change anything.</p>`,
    });
    if (guestMail.error) {
      console.error("guest confirmation failed", guestMail.error);
    }
  } catch (error) {
    console.error("booking email failed", error);
  }

  return json(201, {
    ok: true,
    id: bookingId,
    message: "Request received. We'll confirm by phone or email.",
  });
};

export const config: Config = {
  path: "/api/booking",
};
