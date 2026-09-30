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
  if (!isNewPatientBooking(session)) {
    return;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  const candidateFields = {
    ...(result.collectedFields ?? {}),
    ...(result.toolRequest?.arguments ?? {})
  };
  const changedFields = new Set<NewPatientConfirmationField>();
  const promptedAtTurnStart = state.prompted;

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

    if (promptedAtTurnStart?.field === field
      && normalizeValue(promptedAtTurnStart.value) !== normalizeValue(candidate)) {
      state.prompted = {
        field,
        value: candidate,
        kind: "CONFIRM"
      };
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
      state.correctionAttempts = {
        ...state.correctionAttempts,
        [field]: 0
      };
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

  const prompted = promptedAtTurnStart;
  if (prompted
    && state.prompted === prompted
    && callerText
    && sameValue(fieldValue(session, prompted.field), prompted.value)) {
    if (isAffirmative(callerText)
      || (prompted.kind === "CONFIRM" && isLikelyFieldRestatement(prompted.field, callerText))) {
      state.confirmed[prompted.field] = prompted.value;
      state.prompted = undefined;
      state.awaitingCorrectionField = undefined;
      state.awaitingCorrectionValue = undefined;
      if (state.correctionAttempts) {
        delete state.correctionAttempts[prompted.field];
      }
    } else if (isNegative(callerText)) {
      state.prompted = undefined;
      state.awaitingCorrectionField = prompted.field;
      state.awaitingCorrectionValue = prompted.value;
      state.correctionAttempts = {
        ...state.correctionAttempts,
        [prompted.field]: (state.correctionAttempts?.[prompted.field] ?? 0) + 1
      };
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
    const wasPromptedForThisValue = promptedAtTurnStart?.kind === "CONFIRM"
      && promptedAtTurnStart.field === field
      && normalizeValue(promptedAtTurnStart.value) === normalizeValue(value);
    if (value && (wasPromptedForThisValue || normalizeValue(state.confirmed[field]) === normalizeValue(value))) {
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

export function constrainNewPatientDataUpdates(session: CallSession, result: ModelTurnResult): void {
  if (!isNewPatientBooking(session)) {
    return;
  }

  const state = session.newPatientDataConfirmation ?? { confirmed: {} };
  const activeField = state.prompted?.field
    ?? state.awaitingCorrectionField
    ?? pendingNewPatientConfirmation(session);
  const modelFields = new Set([
    ...Object.keys(result.collectedFields ?? {}),
    ...Object.keys(result.toolRequest?.arguments ?? {})
  ]);
  const declaredFields = Array.isArray(result.updatedFields)
    ? result.updatedFields
    : [...modelFields];
  const allowedFields = activeField
    ? new Set([activeField])
    : new Set(declaredFields);
  const acceptedFields = declaredFields.filter((field) => allowedFields.has(field));

  result.updatedFields = acceptedFields;
  if (result.collectedFields) {
    for (const field of newPatientDataFields) {
      if (!allowedFields.has(field)) {
        delete result.collectedFields[field];
      }
    }
  }

  if (result.toolRequest?.arguments && activeField) {
    for (const field of newPatientDataFields) {
      if (field === activeField) {
        continue;
      }

      const knownValue = session.collectedFields[field];
      if (knownValue !== undefined && knownValue !== null && knownValue !== "") {
        result.toolRequest.arguments[field] = knownValue;
      } else {
        delete result.toolRequest.arguments[field];
      }
    }
  }
}

export function hasAllNewPatientData(session: CallSession): boolean {
  if (!isNewPatientBooking(session)) {
    return false;
  }

  return newPatientDataFields.every((field) => !!fieldValue(session, field));
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
    requiredFields: newPatientDataFields,
    confirmationRequiredFields: newPatientConfirmationFields,
    values: Object.fromEntries(newPatientDataFields.map((field) => [field, fieldValue(session, field) ?? null])),
    confirmedFields: newPatientConfirmationFields.filter((field) => (
      !!fieldValue(session, field)
        && normalizeValue(state.confirmed[field]) === normalizeValue(fieldValue(session, field))
    )),
    pendingField: pendingNewPatientConfirmation(session) ?? null,
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
      return session.newPatientDataConfirmation?.prompted?.kind === "CONFIRM"
        ? `I have the patient's first name as ${value}, spelled ${spellNameForSpeech(value)}. Is that correct?`
        : `I have the patient's first name as ${value}. Could you please spell that for me?`;
    case "lastName":
      return session.newPatientDataConfirmation?.prompted?.kind === "CONFIRM"
        ? `I have the patient's last name as ${value}, spelled ${spellNameForSpeech(value)}. Is that correct?`
        : `I have the patient's last name as ${value}. Could you please spell that for me?`;
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

function isAffirmative(value: string): boolean {
  return /^(yes|yeah|yep|correct|right|exactly|confirmed|okay|ok|sounds good|looks good)([\s,.!?]|$)/i.test(value.trim());
}

function isNegative(value: string): boolean {
  return /^(no|nope|incorrect|wrong|not correct|that's wrong|that is wrong)([\s,.!?]|$)/i.test(value.trim());
}

function requiresSpelling(field: NewPatientConfirmationField): boolean {
  return field === "firstName" || field === "lastName";
}

function spellNameForSpeech(value: string): string {
  return Array.from(value.trim()).join(" ");
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

function isLikelyFieldRestatement(field: NewPatientConfirmationField, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /^(what|which|sorry|huh|repeat|pardon)\b/.test(normalized)) {
    return false;
  }

  switch (field) {
    case "dob":
      return /\d|january|february|march|april|may|june|july|august|september|october|november|december/.test(normalized);
    case "patientEmail":
      return /@|\bat\b|\bdot\b|gmail|yahoo|outlook|\.com\b/.test(normalized);
    case "patientPhone":
      return (normalized.match(/\d/g) ?? []).length >= 7;
    case "firstName":
    case "lastName":
      return /^[a-z](?:[a-z\s'-]{1,40})$/i.test(normalized);
  }
}

