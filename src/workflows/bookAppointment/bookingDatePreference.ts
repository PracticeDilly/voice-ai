const defaultTimezone = "America/Los_Angeles";

export function normalizeBookingDatePreference(
  value: unknown,
  timezone: string | undefined,
  nowIso: string
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  const explicitDate = parseExplicitDate(trimmed);
  if (explicitDate !== undefined) {
    return explicitDate;
  }

  const today = localDateParts(timezone, nowIso);
  const normalized = trimmed.toLowerCase();
  if (normalized === "today") {
    return formatDate(today);
  }
  if (normalized === "tomorrow") {
    return formatDate(addDays(today, 1));
  }

  const weekday = weekdayIndex(normalized);
  if (weekday === undefined) {
    return trimmed;
  }

  const daysUntil = (weekday - dayOfWeek(today) + 7) % 7;
  const offset = normalized.includes("next ") ? (daysUntil === 0 ? 7 : daysUntil + 7) : daysUntil;
  return formatDate(addDays(today, offset));
}

export function isBookingDateRangeValid(fromDate: unknown, toDate: unknown): boolean {
  const from = parseNormalizedDate(fromDate);
  const to = parseNormalizedDate(toDate);
  if (from === undefined || to === undefined) {
    return false;
  }

  const differenceInDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return differenceInDays >= 0 && differenceInDays <= 7;
}

function parseExplicitDate(value: string): string | undefined {
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash !== null) {
    return formatDate({ month: Number(slash[1]), day: Number(slash[2]), year: Number(slash[3]) });
  }

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso !== null) {
    return formatDate({ month: Number(iso[2]), day: Number(iso[3]), year: Number(iso[1]) });
  }

  return undefined;
}

function parseNormalizedDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match === null) {
    return undefined;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date;
}

function localDateParts(timezone: string | undefined, nowIso: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone ?? defaultTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(nowIso));

  return {
    month: Number(parts.find(part => part.type === "month")?.value),
    day: Number(parts.find(part => part.type === "day")?.value),
    year: Number(parts.find(part => part.type === "year")?.value)
  };
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    year: date.getUTCFullYear()
  };
}

function dayOfWeek(parts: DateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function weekdayIndex(value: string): number | undefined {
  if (value.includes("sunday")) return 0;
  if (value.includes("monday")) return 1;
  if (value.includes("tuesday")) return 2;
  if (value.includes("wednesday")) return 3;
  if (value.includes("thursday")) return 4;
  if (value.includes("friday")) return 5;
  if (value.includes("saturday")) return 6;
  return undefined;
}

function formatDate(parts: DateParts): string {
  return `${pad(parts.month)}/${pad(parts.day)}/${parts.year}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

interface DateParts {
  month: number;
  day: number;
  year: number;
}
