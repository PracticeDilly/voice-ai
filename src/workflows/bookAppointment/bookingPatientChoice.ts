export type BookingPatientChoice = "NEW_PATIENT" | "RETURNING_PATIENT";

export function bookingPatientChoiceFromSpeech(text: string): BookingPatientChoice | undefined {
  const normalized = text.trim().toLowerCase();
  const newPatient = /\b(?:new|first[- ]time) patient\b|\bfirst (?:visit|time)\b|\bnever (?:been|visited)\b/.test(normalized);
  const returningPatient = /\b(?:existing|returning|current) patient\b|\b(?:been|visited) (?:here |there )?before\b/.test(normalized);
  if (/\b(?:not|no longer) (?:a )?new patient\b/.test(normalized)) return "RETURNING_PATIENT";
  if (/\b(?:not|no longer) (?:an? )?(?:existing|returning) patient\b/.test(normalized)) return "NEW_PATIENT";
  if (newPatient === returningPatient) return undefined;
  return newPatient ? "NEW_PATIENT" : "RETURNING_PATIENT";
}
