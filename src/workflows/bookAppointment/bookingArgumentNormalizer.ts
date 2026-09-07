import { CallSession } from "../../calls/callSession.js";
import { normalizeBookingDatePreference } from "./bookingDatePreference.js";

const bookingFieldNames = [
  "firstName",
  "lastName",
  "dob",
  "bookingReason",
  "providerName",
  "datePreference",
  "timePreference",
  "slotDate",
  "slotTime",
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

  copyKnownValue(normalized, "fromNumber", normalized.fromNumber ?? session.fromNumber);

  const datePreference = normalizeBookingDatePreference(
    normalized.datePreference,
    session.officeContext?.timezone,
    session.startedAt
  );
  copyKnownValue(normalized, "datePreference", datePreference);

  copyKnownValue(normalized, "slotDate", toolArguments?.slotDate ?? session.workflowState?.context?.slotDate);
  copyKnownValue(normalized, "slotTime", toolArguments?.slotTime ?? session.workflowState?.context?.slotTime);

  return normalized;
}

function copyKnownValue(target: Record<string, unknown>, fieldName: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") {
    target[fieldName] = value;
  }
}
