const officeTimezoneAliases: Record<string, string> = {
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MST: "America/Denver",
  MDT: "America/Denver",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
  HST: "Pacific/Honolulu",
  UTC: "UTC",
  GMT: "UTC"
};

export function officeTimezoneForDate(timezone: string | undefined, fallback: string): string {
  if (!timezone || timezone.trim() === "") {
    return fallback;
  }

  const value = timezone.trim();
  return officeTimezoneAliases[value.toUpperCase()] ?? value;
}

