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
const REQUIRED_NOTIFY_EMAILS = ["montrosecafebistro@gmail.com"];
const WASABI_DIGITAL_URL = "https://Wasabi.Digital";

function wasabiFooterText() {
  return `Systems provided by Wasabi Digital AI engineers.\n${WASABI_DIGITAL_URL}`;
}

function wasabiFooterHtml() {
  return `<p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #2a241f;color:#8a8278;font-size:12px;line-height:1.6;">
        Systems provided by <a href="${WASABI_DIGITAL_URL}" style="color:#c9a96e;text-decoration:none;">Wasabi Digital</a> AI engineers.
      </p>`;
}

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
    "",
    wasabiFooterText(),
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
      ${wasabiFooterHtml()}
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
    ...REQUIRED_NOTIFY_EMAILS,
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

const DIETARY_NOTE_RE = /\b(allerg|dietary|gluten|coeliac|celiac|nut|peanut|dairy|lactose|vegan|vegetarian|shellfish|seafood|halal|kosher|intoleran)\b/i;

export type DigestBooking = {
  kind: string;
  guest: string;
  partySize: number;
  time: string;
  tableLabel: string;
  notes: string;
  status: string;
};

function digestRecipients() {
  const custom = env("BOOKING_DIGEST_EMAILS");
  if (custom) {
    const parsed = custom
      .split(/[;,]/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => EMAIL_RE.test(value));
    if (parsed.length) return parsed;
  }
  return staffRecipients();
}

function digestBriefing(rows: DigestBooking[]) {
  if (!rows.length) {
    return "No pending or confirmed bookings for today.";
  }
  const covers = rows.reduce((sum, row) => sum + row.partySize, 0);
  const tables = rows.filter((row) => row.kind === "table").length;
  const highTea = rows.filter((row) => row.kind === "hightea").length;
  const dietary = rows.filter((row) => row.notes && DIETARY_NOTE_RE.test(row.notes));
  const pending = rows.filter((row) => row.status === "pending").length;
  const parts = [
    `Today: ${rows.length} booking${rows.length === 1 ? "" : "s"}, ${covers} guest${covers === 1 ? "" : "s"}.`,
  ];
  if (tables || highTea) {
    const detail = [
      tables ? `${tables} table` : "",
      highTea ? `${highTea} high tea` : "",
    ].filter(Boolean).join(", ");
    parts.push(`Breakdown: ${detail}.`);
  }
  if (dietary.length) {
    parts.push(
      `${dietary.length} guest${dietary.length === 1 ? "" : "s"} noted dietary requirements or allergies — highlighted below.`,
    );
  }
  if (pending) {
    parts.push(`${pending} booking${pending === 1 ? "" : "s"} still awaiting confirmation.`);
  }
  return parts.join(" ");
}

function kindLabel(kind: string) {
  return kind === "hightea" ? "High tea" : "Table";
}

export function digestBookingFromRow(row: Record<string, unknown>): DigestBooking {
  const first = String(row.first_name || "").trim();
  const last = String(row.last_name || "").trim();
  const guest = [first, last].filter(Boolean).join(" ").trim() || String(row.name || "").trim() || "Guest";
  const party = parseInt(String(row.party_size ?? ""), 10);
  return {
    kind: String(row.kind || "table"),
    guest,
    partySize: Number.isFinite(party) ? party : 0,
    time: String(row.visit_time || "").trim(),
    tableLabel: String(row.table_label || "").trim(),
    notes: String(row.notes || "").trim(),
    status: String(row.status || "").trim(),
  };
}

export function buildBookingDigestEmail(date: string, rows: DigestBooking[]) {
  const headingDate = prettyDate(date);
  const briefing = digestBriefing(rows);
  const covers = rows.reduce((sum, row) => sum + row.partySize, 0);
  const subject = rows.length
    ? `Today's bookings — ${headingDate} (${covers} guest${covers === 1 ? "" : "s"})`
    : `Today's bookings — ${headingDate} (none)`;

  const textLines = [
    "Papà Brizio — daily booking summary",
    headingDate,
    "",
    briefing,
    "",
  ];
  if (rows.length) {
    textLines.push("Time\tGuests\tName\tType\tTable\tNotes / dietary");
    for (const row of rows) {
      textLines.push([
        row.time,
        String(row.partySize),
        row.guest,
        kindLabel(row.kind),
        row.tableLabel || "—",
        row.notes || "—",
      ].join("\t"));
    }
  }
  textLines.push("", "View or edit in the staff admin: https://papabrizio.co.nz/admin", "", wasabiFooterText());

  const tableRows = rows.map((row) => {
    const highlight = row.notes && DIETARY_NOTE_RE.test(row.notes);
    const bg = highlight ? "background:#3d2a1f;" : "";
    return `<tr style="${bg}">
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${escapeHtml(row.time)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${row.partySize}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${escapeHtml(row.guest)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${escapeHtml(kindLabel(row.kind))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${escapeHtml(row.tableLabel || "—")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a241f;">${escapeHtml(row.notes || "—")}</td>
    </tr>`;
  }).join("");

  const tableHtml = rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;">
      <thead>
        <tr style="color:#c9a96e;text-align:left;">
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Time</th>
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Guests</th>
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Name</th>
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Type</th>
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Table</th>
          <th style="padding:8px 12px;border-bottom:1px solid #c9a96e;">Notes / dietary</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`
    : `<p style="margin:16px 0 0;color:#b9b0a4;">No bookings to list for this day.</p>`;

  const html = `
    <div style="font-family:Georgia,serif;background:#14110f;color:#f5f0e8;padding:32px;">
      <p style="color:#c9a96e;letter-spacing:0.16em;text-transform:uppercase;font-size:12px;margin:0 0 8px;">Papà Brizio</p>
      <h1 style="font-weight:400;font-size:26px;margin:0 0 8px;">Today's bookings</h1>
      <p style="margin:0 0 20px;color:#b9b0a4;font-size:15px;">${escapeHtml(headingDate)}</p>
      <p style="margin:0 0 8px;font-size:16px;line-height:1.6;">${escapeHtml(briefing)}</p>
      ${tableHtml}
      <p style="margin:24px 0 0;color:#b9b0a4;font-size:13px;">Rows with a darker background mention allergies or dietary needs in the guest notes.</p>
      <p style="margin:12px 0 0;color:#b9b0a4;font-size:13px;"><a href="https://papabrizio.co.nz/admin" style="color:#c9a96e;">Open staff admin</a></p>
      ${wasabiFooterHtml()}
    </div>
  `;

  return { subject, text: textLines.join("\n"), html };
}

export async function sendBookingDigest(date: string, rows: DigestBooking[]) {
  const key = env("RESEND_API_KEY");
  if (!key) return { ok: false, error: "Email sending is not configured yet." };
  const fromEmail = env("RESEND_FROM") || "Papa Brizio <bookings@papabrizio.co.nz>";
  const copy = buildBookingDigestEmail(date, rows);
  const resend = new Resend(key);
  const recipients = digestRecipients();
  const results = await Promise.all(recipients.map(async (to) => {
    const result = await deliverWithRetry(resend, {
      from: fromEmail,
      to,
      replyTo: recipients[0],
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
    });
    if (!result.ok) console.error("digest email failed", to, result.error);
    return result;
  }));
  const failed = results.filter((result) => !result.ok);
  return failed.length
    ? { ok: false, error: `${failed.length} digest email(s) failed.` }
    : { ok: true };
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
