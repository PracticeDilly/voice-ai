import { CallSession } from "../../calls/callSession.js";
import { normalizeBookingDatePreference } from "./bookingDatePreference.js";
import {
  normalizeProviderText,
  singleOfficeContextProviderName
} from "./officeContextProviders.js";

const bookingFieldNames = [
  "firstName",
  "lastName",
  "dob",
  "bookingReason",
  "appointmentTypeId",
  "providerName",
  "datePreference",
  "timePreference",
  "slotDate",
  "slotTime",
  "fromDate",
  "toDate",
  "callerConfirmedBooking"
];

export function normalizeBookingArguments(
  session: CallSession,
  toolArguments: Record<string, unknown> | undefined
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const fieldName of bookingFieldNames) {
    copyKnownValue(normalized, fieldName, toolArguments?.[fieldName] ?? session.collectedFields[fieldName]);
  }
  applySingleOfficeContextProvider(normalized, session);

  copyKnownValue(normalized, "fromNumber", normalized.fromNumber ?? session.fromNumber);

  const datePreference = normalizeBookingDatePreference(
    normalized.datePreference,
    session.officeContext?.timezone,
    session.startedAt
  );
  copyKnownValue(normalized, "datePreference", datePreference);
  const fromDate = normalizeBookingDatePreference(
    normalized.fromDate ?? normalized.datePreference,
    session.officeContext?.timezone,
    session.startedAt
  );
  const toDate = normalizeBookingDatePreference(
    normalized.toDate ?? fromDate,
    session.officeContext?.timezone,
    session.startedAt
  );
  copyKnownValue(normalized, "fromDate", fromDate);
  copyKnownValue(normalized, "toDate", toDate);

  copyKnownValue(normalized, "slotDate", toolArguments?.slotDate ?? session.workflowState?.context?.slotDate);
  copyKnownValue(normalized, "slotTime", toolArguments?.slotTime ?? session.workflowState?.context?.slotTime);
  applySelectedSlotFromTimePreference(normalized, session);

  return normalized;
}

function copyKnownValue(target: Record<string, unknown>, fieldName: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") {
    target[fieldName] = value;
  }
}

function applySingleOfficeContextProvider(target: Record<string, unknown>, session: CallSession): void {
  if (hasValue(target.providerName)) {
    return;
  }

  const providerName = singleOfficeContextProviderName(session.officeContext?.providers);
  copyKnownValue(target, "providerName", providerName);
}

function applySelectedSlotFromTimePreference(target: Record<string, unknown>, session: CallSession): void {
  if (hasValue(target.slotDate) && hasValue(target.slotTime)) {
    return;
  }

  if (session.workflowState?.workflow !== "BOOK_APPOINTMENT" || session.workflowState.state !== "SELECT_SLOT") {
    return;
  }

  const timePreference = target.timePreference;
  if (!hasValue(timePreference)) {
    return;
  }

  const matchingSlot = findMatchingSlot(session.workflowState.context?.slots, String(timePreference));
  if (!matchingSlot) {
    return;
  }

  copyKnownValue(target, "slotDate", matchingSlot.slotDate);
  copyKnownValue(target, "slotTime", matchingSlot.slotTime);
}

function findMatchingSlot(slots: unknown[] | undefined, selectedTime: string): { slotDate?: unknown; slotTime?: unknown } | undefined {
  if (!Array.isArray(slots)) {
    return undefined;
  }

  const normalizedSelectedTime = normalizeTime(selectedTime);
  if (!normalizedSelectedTime) {
    return undefined;
  }

  return slots
    .map(asSlot)
    .find((slot) => normalizeTime(slot?.slotTime) === normalizedSelectedTime);
}

function asSlot(value: unknown): { slotDate?: unknown; slotTime?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as { slotDate?: unknown; slotTime?: unknown };
}

function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return normalizeProviderText(value);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
