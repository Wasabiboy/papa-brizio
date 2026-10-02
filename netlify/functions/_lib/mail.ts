import { Resend } from "resend";
import { env } from "./env";

export type BookingKind = "table" | "hightea";

export type BookingMail = {
  kind: BookingKind;
  guest: string;
  phone: string;
  email: string;
  partySize: string;
  date: string;
  time: string;
  notes?: string;
  tableLabel?: string;
  newsletter?: string;
  occasion?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_NOTIFY_EMAIL = "montrosecafe@xtra.co.nz";

type MailResult = {
  ok: boolean;
  error?: string;
};

type EmailPayload = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

function prettyDate(iso: string) {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function bookingTitle(kind: BookingKind) {
  return kind === "hightea" ? "High Tea booking" : "Table reservation";
}

export function bookingEmail(data: BookingMail, mode: "request" | "confirmed") {
  const title = bookingTitle(data.kind);
  const heading = mode === "confirmed" ? `${title} confirmed` : `${title} request`;
  const footer = mode === "confirmed"
    ? "Your booking is confirmed. Call 09 478 9610 if you need to change anything."
    : "This request is pending confirmation.";
  const rows = [
    ["Name", data.guest],
    ["Phone", data.phone],
    ["Email", data.email],
    ["Party", data.partySize],
    ["Date", prettyDate(data.date)],
    ["Time", data.time],
  ];
  if (data.tableLabel) rows.push(["Table", data.tableLabel]);
  if (data.newsletter) rows.push(["Newsletter", data.newsletter]);
  if (data.occasion) rows.push(["Occasion", data.occasion]);
  rows.push(["Notes", data.notes || "None"]);

  const text = [
    heading,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Papà Brizio, 1 Montrose Terrace, Mairangi Bay",
    footer,
  ].join("\n");

  const htmlRows = rows.map(([label, value]) => (
    `<tr><td style="padding:4px 16px 4px 0;color:#c9a96e;">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`
  )).join("");

  const html = `
    <div style="font-family:Georgia,serif;background:#14110f;color:#f5f0e8;padding:32px;">
      <p style="color:#c9a96e;letter-spacing:0.16em;text-transform:uppercase;font-size:12px;margin:0 0 8px;">Papà Brizio</p>
      <h1 style="font-weight:400;font-size:28px;margin:0 0 24px;">${escapeHtml(heading)}</h1>
      <table style="border-collapse:collapse;font-size:16px;line-height:1.6;">${htmlRows}</table>
      <p style="margin:24px 0 0;color:#b9b0a4;font-size:14px;">1 Montrose Terrace, Mairangi Bay</p>
      <p style="margin:8px 0 0;color:#b9b0a4;font-size:14px;">${escapeHtml(footer)}</p>
    </div>
  `;
  return { title, heading, text, html };
}

function staffRecipients() {
  const configured = env("BOOKING_NOTIFY_EMAILS") || env("BOOKING_NOTIFY_EMAIL") || DEFAULT_NOTIFY_EMAIL;
  const configuredRecipients = [configured]
    .flatMap((value) => value.split(/[;,]/))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => EMAIL_RE.test(value));
  const testRecipients = env("BOOKING_TEST_EMAIL")
    .split(/[;,]/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => EMAIL_RE.test(value));
  return [...new Set([
    ...(configuredRecipients.length ? configuredRecipients : [DEFAULT_NOTIFY_EMAIL]),
    ...testRecipients,
  ])];
}

async function deliverWithRetry(
  resend: Resend,
  payload: EmailPayload,
): Promise<MailResult> {
  let lastError = "Email delivery failed.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await resend.emails.send(payload);
      if (!result.error) return { ok: true };
      lastError = result.error.message;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}

export async function sendGuestMessage(data: BookingMail, mode: "request" | "confirmed") {
  const key = env("RESEND_API_KEY");
  if (!key) return { ok: false, error: "Email sending is not configured yet." };
  const notifyEmail = staffRecipients()[0];
  const fromEmail = env("RESEND_FROM") || "Papa Brizio <bookings@papabrizio.co.nz>";
  const copy = bookingEmail(data, mode);
  const resend = new Resend(key);
  const subject = mode === "confirmed"
    ? `Your ${copy.title.toLowerCase()} is confirmed`
    : `We received your ${copy.title.toLowerCase()} request`;
  const intro = mode === "confirmed"
    ? `Kia ora ${data.guest},\n\nYour booking at Papà Brizio is confirmed.\n\n`
    : `Kia ora ${data.guest},\n\nThanks for your request at Papà Brizio.\n\n`;
  const payload = {
    from: fromEmail,
    to: data.email,
    replyTo: notifyEmail,
    subject,
    text: intro + copy.text,
    html: copy.html,
  };
  return deliverWithRetry(resend, payload);
}

export async function sendStaffAlert(data: BookingMail) {
  const key = env("RESEND_API_KEY");
  if (!key) return { ok: false, error: "Email sending is not configured yet." };
  const fromEmail = env("RESEND_FROM") || "Papa Brizio <bookings@papabrizio.co.nz>";
  const copy = bookingEmail(data, "request");
  const resend = new Resend(key);
  const results = await Promise.all(staffRecipients().map(async (to) => {
    const result = await deliverWithRetry(resend, {
      from: fromEmail,
      to,
      replyTo: data.email,
      subject: `${copy.title} — ${data.guest}`,
      text: copy.text,
      html: copy.html,
    });
    if (!result.ok) console.error("staff email failed", to, result.error);
    return result;
  }));
  const failed = results.filter((result) => !result.ok);
  return failed.length
    ? { ok: false, error: `${failed.length} staff notification email(s) failed.` }
    : { ok: true };
}
