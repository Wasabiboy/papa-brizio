export type DayHours = {
  weekday: number;
  label: string;
  closed: boolean;
  open: string | null;
  lastSlot: string | null;
};

export type VenueSettings = {
  timezone: string;
  slotMinutes: number;
  hours: DayHours[];
  closedDates: string[];
};

export const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const DEFAULT_SETTINGS: VenueSettings = {
  timezone: "Pacific/Auckland",
  slotMinutes: 15,
  closedDates: [],
  hours: [
    { weekday: 0, label: "Sunday", closed: false, open: "08:00", lastSlot: "20:00" },
    { weekday: 1, label: "Monday", closed: true, open: null, lastSlot: null },
    { weekday: 2, label: "Tuesday", closed: true, open: null, lastSlot: null },
    { weekday: 3, label: "Wednesday", closed: false, open: "08:00", lastSlot: "20:00" },
    { weekday: 4, label: "Thursday", closed: false, open: "08:00", lastSlot: "20:00" },
    { weekday: 5, label: "Friday", closed: false, open: "08:00", lastSlot: "20:00" },
    { weekday: 6, label: "Saturday", closed: false, open: "08:00", lastSlot: "20:00" },
  ],
};

const HHMM = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTimeToMinutes(value: string) {
  const raw = String(value || "").trim();
  const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!ampm) return null;
  let hour = Number(ampm[1]);
  const minute = Number(ampm[2]);
  const suffix = ampm[3]?.toLowerCase();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function asHours(value: unknown): DayHours[] {
  const rows = Array.isArray(value) ? value : [];
  return DAY_LABELS.map((label, weekday) => {
    const row = rows.find((item) => Number((item as DayHours).weekday) === weekday) as DayHours | undefined;
    const closed = row ? Boolean(row.closed) : weekday === 1;
    const open = !closed && row?.open && HHMM.test(row.open) ? row.open : null;
    const lastSlot = !closed && row?.lastSlot && HHMM.test(row.lastSlot) ? row.lastSlot : null;
    return {
      weekday,
      label,
      closed: closed || !open || !lastSlot,
      open: closed ? null : open,
      lastSlot: closed ? null : lastSlot,
    };
  });
}

export function normalizeSettings(input: Partial<VenueSettings> | Record<string, unknown> | null | undefined): VenueSettings {
  const slot = Number(input?.slotMinutes ?? (input as { slot_minutes?: number })?.slot_minutes ?? DEFAULT_SETTINGS.slotMinutes);
  const dates = Array.isArray(input?.closedDates)
    ? input.closedDates
    : Array.isArray((input as { closed_dates?: string[] })?.closed_dates)
      ? (input as { closed_dates: string[] }).closed_dates
      : [];
  return {
    timezone: String(input?.timezone || DEFAULT_SETTINGS.timezone),
    slotMinutes: [10, 15, 30, 60].includes(slot) ? slot : 15,
    hours: asHours(input?.hours),
    closedDates: [...new Set(dates.map((d) => String(d)).filter((d) => DATE.test(d)))].sort(),
  };
}

export function settingsFromRow(row: Record<string, unknown> | undefined) {
  if (!row) return DEFAULT_SETTINGS;
  return normalizeSettings({
    timezone: row.timezone as string,
    slotMinutes: row.slot_minutes as number,
    hours: row.hours as DayHours[],
    closedDates: row.closed_dates as string[],
  });
}

export function isOpenOnDate(settings: VenueSettings, date: string) {
  if (!DATE.test(date) || settings.closedDates.includes(date)) return false;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const day = settings.hours.find((item) => item.weekday === weekday);
  return Boolean(day && !day.closed && day.open && day.lastSlot);
}

export function isValidSlot(settings: VenueSettings, date: string, time: string) {
  if (!isOpenOnDate(settings, date)) return false;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const day = settings.hours.find((item) => item.weekday === weekday);
  if (!day?.open || !day.lastSlot) return false;
  const t = parseTimeToMinutes(time);
  const start = parseTimeToMinutes(day.open);
  const end = parseTimeToMinutes(day.lastSlot);
  if (t == null || start == null || end == null || t < start || t > end) return false;
  return (t - start) % settings.slotMinutes === 0;
}
