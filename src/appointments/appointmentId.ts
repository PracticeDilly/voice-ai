export function normalizeAppointmentId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const normalizedValue = BigInt(value.trim());
    return normalizedValue > 0n ? normalizedValue.toString() : undefined;
  }

  return undefined;
}
