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

export async function sendGuestMessage(data: BookingMail, mode: "request" | "confirmed") {
  const key = env("RESEND_API_KEY");
  if (!key) return { ok: false, error: "Email sending is not configured yet." };
  const notifyEmail = env("BOOKING_NOTIFY_EMAIL") || "montrosecafe@xtra.co.nz";
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
  let result = await resend.emails.send(payload);
  if (result.error) {
    result = await resend.emails.send(payload);
  }
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function sendStaffAlert(data: BookingMail) {
  const key = env("RESEND_API_KEY");
  if (!key) return;
  const notifyEmail = env("BOOKING_NOTIFY_EMAIL") || "montrosecafe@xtra.co.nz";
  const testEmail = env("BOOKING_TEST_EMAIL");
  const fromEmail = env("RESEND_FROM") || "Papa Brizio <bookings@papabrizio.co.nz>";
  const copy = bookingEmail(data, "request");
  const resend = new Resend(key);
  const staffTo = [...new Set([notifyEmail, testEmail].filter(Boolean))];
  for (const to of staffTo) {
    const result = await resend.emails.send({
      from: fromEmail,
      to,
      replyTo: data.email,
      subject: `${copy.title} — ${data.guest}`,
      text: copy.text,
      html: copy.html,
    });
    if (result.error) console.error("staff email failed", to, result.error);
  }
}
