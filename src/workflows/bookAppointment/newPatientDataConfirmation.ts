import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import { bookingPatientType } from "./appointmentTypeSelection.js";

export const newPatientConfirmationFields = [
  "firstName",
  "lastName",
  "dob",
  "gender",
  "patientEmail",
  "patientPhone"
] as const;

export type NewPatientConfirmationField = typeof newPatientConfirmationFields[number];

export interface NewPatientDataConfirmationState {
  confirmed: Partial<Record<NewPatientConfirmationField, string>>;
  prompted?: {
    field: NewPatientConfirmationField;
    value: string;
    kind: "SPELL" | "CONFIRM";
  };
  awaitingCorrectionField?: NewPatientConfirmationField;
  awaitingCorrectionValue?: string;
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
  if (!isNewPatientBooking(session)) {
    return;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  const candidateFields = {
    ...(result.collectedFields ?? {}),
    ...(result.toolRequest?.arguments ?? {})
  };
  const changedFields = new Set<NewPatientConfirmationField>();

  if (state.summaryPrompted && callerText) {
    if (isAffirmative(callerText)) {
      state.summaryPrompted = false;
      state.summaryConfirmed = true;
      state.summaryAwaitingCorrection = false;
    } else if (isNegative(callerText)) {
      state.summaryPrompted = false;
      state.summaryConfirmed = false;
      state.summaryAwaitingCorrection = true;
    }
  }

  for (const field of newPatientConfirmationFields) {
    const candidate = textValue(candidateFields[field]);
    if (!candidate) {
      continue;
    }

    const confirmedValue = state.confirmed[field];
    const promptedValue = state.prompted?.field === field ? state.prompted.value : undefined;
    if (confirmedValue && normalizeValue(confirmedValue) !== normalizeValue(candidate)) {
      delete state.confirmed[field];
      changedFields.add(field);
      state.summaryConfirmed = false;
      state.summaryPrompted = false;
      state.summaryAwaitingCorrection = false;
    }

    if (state.prompted?.field === field
      && normalizeValue(state.prompted.value) !== normalizeValue(candidate)) {
      state.prompted = undefined;
      state.awaitingCorrectionField = field;
      state.awaitingCorrectionValue = confirmedValue ?? promptedValue;
      changedFields.add(field);
      state.summaryConfirmed = false;
      state.summaryPrompted = false;
      state.summaryAwaitingCorrection = false;
    }

    if (state.awaitingCorrectionField === field
      && normalizeValue(candidate) !== normalizeValue(state.awaitingCorrectionValue)) {
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
    }
  }

  const prompted = state.prompted;
  if (prompted && callerText && sameValue(fieldValue(session, prompted.field), prompted.value)) {
    if (isAffirmative(callerText)
      || (prompted.kind === "CONFIRM" && isLikelyFieldRestatement(prompted.field, callerText))) {
      state.confirmed[prompted.field] = prompted.value;
      state.prompted = undefined;
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
    } else if (isNegative(callerText)) {
      state.prompted = undefined;
      state.awaitingCorrectionField = prompted.field;
      state.awaitingCorrectionValue = prompted.value;
      delete state.confirmed[prompted.field];
    } else if (prompted.kind === "SPELL") {
      state.prompted = {
        field: prompted.field,
        value: prompted.value,
        kind: "CONFIRM"
      };
    }
  }

  for (const field of result.confirmedFields ?? []) {
    if (!isConfirmationField(field) || changedFields.has(field)) {
      continue;
    }

    const value = textValue(candidateFields[field]) ?? fieldValue(session, field);
    if (value) {
      state.confirmed[field] = value;
      if (state.prompted?.field === field) {
        state.prompted = undefined;
      }
      if (state.awaitingCorrectionField === field) {
        state.awaitingCorrectionField = undefined;
        state.awaitingCorrectionValue = undefined;
      }
    }
  }

  session.newPatientDataConfirmation = state;
}

export function hasAllNewPatientData(session: CallSession): boolean {
  if (!isNewPatientBooking(session)) {
    return false;
  }

  return newPatientConfirmationFields.every((field) => !!fieldValue(session, field));
}

export function pendingNewPatientConfirmation(
  session: CallSession
): NewPatientConfirmationField | undefined {
  if (!hasAllNewPatientData(session)) {
    return undefined;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  return newPatientConfirmationFields.find((field) => (
    normalizeValue(state.confirmed[field]) !== normalizeValue(fieldValue(session, field))
  ));
}

export function allNewPatientDataConfirmed(session: CallSession): boolean {
  return hasAllNewPatientData(session)
    && pendingNewPatientConfirmation(session) === undefined
    && session.newPatientDataConfirmation?.summaryConfirmed === true;
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
      kind: requiresSpelling(field) ? "SPELL" : "CONFIRM"
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
    requiredFields: newPatientConfirmationFields,
    values: Object.fromEntries(newPatientConfirmationFields.map((field) => [field, fieldValue(session, field) ?? null])),
    confirmedFields: newPatientConfirmationFields.filter((field) => (
      !!fieldValue(session, field)
        && normalizeValue(state.confirmed[field]) === normalizeValue(fieldValue(session, field))
    )),
    pendingField: pendingNewPatientConfirmation(session) ?? null,
    awaitingCorrectionField: state.awaitingCorrectionField ?? null,
    summaryConfirmed: state.summaryConfirmed === true,
    summaryPending: hasAllNewPatientData(session)
      && pendingNewPatientConfirmation(session) === undefined
      && state.summaryConfirmed !== true
  };
}

export function newPatientConfirmationQuestion(
  session: CallSession,
  field: NewPatientConfirmationField
): string {
  const value = fieldValue(session, field) ?? "";
  if (session.newPatientDataConfirmation?.awaitingCorrectionField === field) {
    return correctionQuestion(field);
  }

  switch (field) {
    case "firstName":
      return session.newPatientDataConfirmation?.prompted?.kind === "CONFIRM"
        ? `I have the patient's first name as ${value}. Is that correct?`
        : `I have the patient's first name as ${value}. Could you please spell that for me?`;
    case "lastName":
      return session.newPatientDataConfirmation?.prompted?.kind === "CONFIRM"
        ? `I have the patient's last name as ${value}. Is that correct?`
        : `I have the patient's last name as ${value}. Could you please spell that for me?`;
    case "dob":
      return `I have the patient's date of birth as ${value}. Is that correct?`;
    case "gender":
      return `I have the patient's gender recorded as ${value}. Is that correct?`;
    case "patientEmail":
      return `Let me spell back the patient's email: ${spellEmailForSpeech(value)}. Is that correct?`;
    case "patientPhone":
      return `I have the patient's phone number as ${value}. Is that correct?`;
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
    case "gender":
      return "What gender should we record for the patient?";
    case "patientEmail":
      return "What is the correct email address? Please spell it out slowly.";
    case "patientPhone":
      return "What is the correct phone number? Please provide it again.";
  }
}

function fieldValue(session: CallSession, field: NewPatientConfirmationField): string | undefined {
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

function isAffirmative(value: string): boolean {
  return /^(yes|yeah|yep|correct|right|exactly|confirmed|okay|ok|sounds good|looks good)([\s,.!?]|$)/i.test(value.trim());
}

function isNegative(value: string): boolean {
  return /^(no|nope|incorrect|wrong|not correct|that's wrong|that is wrong)([\s,.!?]|$)/i.test(value.trim());
}

function requiresSpelling(field: NewPatientConfirmationField): boolean {
  return field === "firstName" || field === "lastName";
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

function isLikelyFieldRestatement(field: NewPatientConfirmationField, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /^(what|which|sorry|huh|repeat|pardon)\b/.test(normalized)) {
    return false;
  }

  switch (field) {
    case "dob":
      return /\d|january|february|march|april|may|june|july|august|september|october|november|december/.test(normalized);
    case "gender":
      return /\b(male|female|man|woman)\b/.test(normalized);
    case "patientEmail":
      return /@|\bat\b|\bdot\b|gmail|yahoo|outlook|\.com\b/.test(normalized);
    case "patientPhone":
      return (normalized.match(/\d/g) ?? []).length >= 7;
    case "firstName":
    case "lastName":
      return /^[a-z](?:[a-z\s'-]{1,40})$/i.test(normalized);
  }
}
