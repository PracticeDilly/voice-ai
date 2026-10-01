import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import { bookingPatientType } from "./patientType.js";

export const newPatientDataFields = [
  "firstName",
  "lastName",
  "dob",
  "gender",
  "patientEmail",
  "patientPhone"
] as const;

export const newPatientConfirmationFields = [
  "firstName",
  "lastName",
  "dob",
  "patientEmail",
  "patientPhone"
] as const;

export type NewPatientDataField = typeof newPatientDataFields[number];
export type NewPatientConfirmationField = typeof newPatientConfirmationFields[number];

export interface NewPatientDataConfirmationState {
  confirmed: Partial<Record<NewPatientConfirmationField, string>>;
  nameReadBack?: string;
  unclearFields?: string[];
  prompted?: {
    field: NewPatientConfirmationField;
    value: string;
    kind: "SPELL" | "CONFIRM";
  };
  awaitingCorrectionField?: NewPatientConfirmationField;
  awaitingCorrectionValue?: string;
  correctionAttempts?: Partial<Record<NewPatientConfirmationField, number>>;
  summaryPrompted?: boolean;
  summaryConfirmed?: boolean;
  summaryAwaitingCorrection?: boolean;
}

export function isNewPatientBooking(session: CallSession): boolean {
  return bookingPatientType(session) === "NEW_PATIENT"
    && (session.newPatientBookingCandidate === true
      || session.workflowState?.context?.patientType === "NEW_PATIENT");
}

export function synchronizeNewPatientDataConfirmation(
  session: CallSession,
  result: ModelTurnResult,
  callerText?: string
): void {
  if (!isNewPatientBooking(session)) return;
  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  const prompted = state.prompted;
  const candidates = { ...result.toolRequest?.arguments, ...result.collectedFields };
  if (callerText) {
    const unclear = new Set(state.unclearFields ?? []);
    for (const field of result.updatedFields ?? []) {
      if (textValue(candidates[field])) unclear.delete(field);
    }
    for (const field of result.unclearFields ?? []) {
      if ((newPatientDataFields as readonly string[]).includes(field)) unclear.add(field);
    }
    state.unclearFields = [...unclear];
  }
  for (const field of newPatientConfirmationFields) {
    const value = textValue(candidates[field]) ?? fieldValue(session, field);
    if (!value) continue;
    if (state.confirmed[field] && !sameValue(state.confirmed[field], value)) {
      delete state.confirmed[field];
    }
    if (prompted?.field === field && !sameValue(prompted.value, value)) {
      state.prompted = undefined;
    }
    if (state.awaitingCorrectionField === field && !sameValue(state.awaitingCorrectionValue, value)) {
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
    }
  }
  // Only a caller turn may confirm a matching, previously spoken read-back.
  if (callerText && prompted && sameValue(fieldValue(session, prompted.field), prompted.value)) {
    if ((result.callerAction?.speechAct === "DECLINE" || result.callerAction?.speechAct === "CORRECTION")
      && !(result.updatedFields ?? []).some((field) => field !== prompted.field)) {
      state.awaitingCorrectionField = prompted.field;
      state.awaitingCorrectionValue = prompted.value;
      state.correctionAttempts = {
        ...state.correctionAttempts,
        [prompted.field]: (state.correctionAttempts?.[prompted.field] ?? 0) + 1
      };
      delete state.confirmed[prompted.field];
      state.prompted = undefined;
    } else if (result.callerAction?.speechAct !== "CORRECTION"
      && result.confirmedFields?.includes(prompted.field)) {
      state.confirmed[prompted.field] = prompted.value;
      state.prompted = undefined;
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
    }
  }
  session.newPatientDataConfirmation = state;
}

export function constrainNewPatientDataUpdates(session: CallSession, result: ModelTurnResult): void {
  if (!isNewPatientBooking(session)) return;
  const candidates = { ...result.toolRequest?.arguments, ...result.collectedFields };
  const declared = new Set(result.updatedFields ?? []);
  const activeField = session.newPatientDataConfirmation?.prompted?.field
    ?? session.newPatientDataConfirmation?.awaitingCorrectionField;
  const accepted = new Set<string>();
  for (const field of newPatientDataFields) {
    const value = textValue(candidates[field]);
    const known = fieldValue(session, field);
    // Accept all newly supplied fields, including a full name in one answer.
    // Existing values change only through explicitly declared updates.
    if (!result.unclearFields?.includes(field)
      && value && (!known || sameValue(known, value)
        || (declared.has(field) && (!activeField || activeField === field
          || result.callerAction?.speechAct === "CORRECTION")))) {
      accepted.add(field);
      if (result.collectedFields?.[field] === undefined) {
        result.collectedFields = { ...result.collectedFields, [field]: value };
      }
    } else if (result.collectedFields) {
      delete result.collectedFields[field];
    }
    if (result.toolRequest?.arguments) {
      const effective = accepted.has(field) ? value : known;
      if (effective) result.toolRequest.arguments[field] = effective;
      else delete result.toolRequest.arguments[field];
    }
  }
  result.updatedFields = [...declared].filter((field) =>
    !(newPatientDataFields as readonly string[]).includes(field) || accepted.has(field)
  );
}

/** Read a new or corrected name once without adding an approval turn. */
export function readBackNewPatientName(session: CallSession, reply: string): string {
  if (!isNewPatientBooking(session)) return reply;
  const name = [fieldValue(session, "firstName"), fieldValue(session, "lastName")].filter(Boolean).join(" ");
  if (!name) return reply;
  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  if (sameValue(state.nameReadBack, name)) return reply;
  state.nameReadBack = name;
  session.newPatientDataConfirmation = state;
  return `I have the patient's name as ${name}. ${reply}`;
}

export function hasAllNewPatientData(session: CallSession): boolean {
  if (!isNewPatientBooking(session)) {
    return false;
  }

  return !session.newPatientDataConfirmation?.unclearFields?.length
    && newPatientDataFields.every((field) => !!fieldValue(session, field));
}

export function pendingNewPatientConfirmation(
  session: CallSession
): NewPatientConfirmationField | undefined {
  if (!isNewPatientBooking(session)) {
    return undefined;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  for (const field of newPatientDataFields) {
    const value = fieldValue(session, field);
    if (!value) return undefined;
    if (isConfirmationField(field) && requiresExplicitConfirmation(field)
      && normalizeValue(state.confirmed[field]) !== normalizeValue(value)) {
      return field;
    }
  }
  return undefined;
}

export function allNewPatientDataConfirmed(session: CallSession): boolean {
  return hasAllNewPatientData(session)
    && pendingNewPatientConfirmation(session) === undefined;
}

export function markNewPatientSummaryPrompt(session: CallSession): void {
  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  state.summaryPrompted = true;
  state.summaryAwaitingCorrection = false;
  session.newPatientDataConfirmation = state;
}

export function newPatientSummaryQuestion(session: CallSession): string {
  const firstName = fieldValue(session, "firstName") ?? "";
  const lastName = fieldValue(session, "lastName") ?? "";
  const dob = fieldValue(session, "dob") ?? "";
  const gender = fieldValue(session, "gender") ?? "";
  const email = fieldValue(session, "patientEmail") ?? "";
  const phone = fieldValue(session, "patientPhone") ?? "";
  return `Before I continue, I have the patient as ${firstName} ${lastName}, date of birth ${dob}, gender ${gender}, email ${email}, and phone number ${phone}. Is all of that correct?`;
}

export function markNewPatientConfirmationPrompt(
  session: CallSession,
  field: NewPatientConfirmationField
): void {
  const value = fieldValue(session, field);
  if (!value) {
    return;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  const existing = state.prompted;
  if (!existing || existing.field !== field || normalizeValue(existing.value) !== normalizeValue(value)) {
    state.prompted = {
      field,
      value,
      kind: "CONFIRM"
    };
  }
  session.newPatientDataConfirmation = state;
}

export function newPatientDataConfirmationContext(session: CallSession): Record<string, unknown> | undefined {
  if (!isNewPatientBooking(session)) {
    return undefined;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  return {
    requiredFields: newPatientDataFields,
    confirmationRequiredFields: newPatientConfirmationFields.filter(requiresExplicitConfirmation),
    values: Object.fromEntries(newPatientDataFields.map((field) => [field, fieldValue(session, field) ?? null])),
    confirmedFields: newPatientConfirmationFields.filter((field) => (
      !!fieldValue(session, field)
        && normalizeValue(state.confirmed[field]) === normalizeValue(fieldValue(session, field))
    )),
    pendingField: pendingNewPatientConfirmation(session) ?? null,
    unclearFields: state.unclearFields ?? [],
    awaitingCorrectionField: state.awaitingCorrectionField ?? null,
    summaryConfirmed: state.summaryConfirmed === true,
    summaryPending: false
  };
}

export function newPatientConfirmationQuestion(
  session: CallSession,
  field: NewPatientConfirmationField
): string {
  const value = fieldValue(session, field) ?? "";
  if (session.newPatientDataConfirmation?.awaitingCorrectionField === field) {
    if ((session.newPatientDataConfirmation.correctionAttempts?.[field] ?? 0) >= 2) {
      return `I'm still having trouble confirming the patient's ${fieldLabel(field)}. Please provide it one more time, or say staff if you would like help from the office.`;
    }
    return correctionQuestion(field);
  }

  switch (field) {
    case "firstName":
    case "lastName":
      return `I have the patient's name as ${fieldValue(session, "firstName") ?? ""} ${fieldValue(session, "lastName") ?? ""}. Is that correct?`;
    case "dob":
      return `I have the patient's date of birth as ${value}. Is that correct?`;
    case "patientEmail":
      return `Let me spell back the patient's email: ${spellEmailForSpeech(value)}. Is that correct?`;
    case "patientPhone":
      return phoneConfirmationQuestion(session, value);
  }
}

function correctionQuestion(field: NewPatientConfirmationField): string {
  switch (field) {
    case "firstName":
      return "What is the correct first name? Please spell it for me.";
    case "lastName":
      return "What is the correct last name? Please spell it for me.";
    case "dob":
      return "What is the correct date of birth? Please provide it again.";
    case "patientEmail":
      return "What is the correct email address? Please spell it out slowly.";
    case "patientPhone":
      return "What is the correct phone number? Please provide it again.";
  }
}

function fieldValue(session: CallSession, field: NewPatientDataField): string | undefined {
  if (field === "patientPhone") {
    return textValue(session.collectedFields.patientPhone) ?? textValue(session.fromNumber);
  }

  return textValue(session.collectedFields[field]);
}

function isConfirmationField(value: unknown): value is NewPatientConfirmationField {
  return typeof value === "string" && (newPatientConfirmationFields as readonly string[]).includes(value);
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function sameValue(left: string | undefined, right: string): boolean {
  return !!left && normalizeValue(left) === normalizeValue(right);
}

function requiresExplicitConfirmation(field: NewPatientDataField): boolean {
  return field === "patientEmail" || field === "patientPhone";
}

function phoneConfirmationQuestion(session: CallSession, value: string): string {
  const digits = value.replace(/\D/g, "");
  const callerDigits = textValue(session.fromNumber)?.replace(/\D/g, "");
  if (digits && callerDigits && digits === callerDigits) {
    return `Is the number you're calling from, ending in ${digits.slice(-4).split("").join(" ")}, the best phone number for the patient?`;
  }

  return `I have the patient's phone number as ${digits.split("").join(" ") || value}. Is that correct?`;
}

function fieldLabel(field: NewPatientConfirmationField): string {
  switch (field) {
    case "firstName": return "first name";
    case "lastName": return "last name";
    case "dob": return "date of birth";
    case "patientEmail": return "email address";
    case "patientPhone": return "phone number";
  }
}

function spellEmailForSpeech(value: string): string {
  return Array.from(value.trim().toLocaleLowerCase())
    .map((character) => {
      switch (character) {
        case "@":
          return " at ";
        case ".":
          return " dot ";
        case "+":
          return " plus ";
        case "_":
          return " underscore ";
        case "-":
          return " dash ";
        default:
          return `${character} `;
      }
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

