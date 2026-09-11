import { CallSession } from "../../calls/callSession.js";
import { addDaysToBookingDate, normalizeBookingDatePreference } from "./bookingDatePreference.js";
import {
  singleOfficeContextProviderName
} from "./officeContextProviders.js";

const bookingFieldNames = [
  "firstName",
  "lastName",
  "dob",
  "bookingReason",
  "appointmentTypeId",
  "providerName",
  "patientPhone",
  "patientEmail",
  "datePreference",
  "timePreference",
  "slotDate",
  "slotTime",
  "fromDate",
  "toDate",
  "callerConfirmedBooking",
  "continueAsNewPatient"
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
  let toDate = normalizeBookingDatePreference(
    normalized.toDate ?? fromDate,
    session.officeContext?.timezone,
    session.startedAt
  );
  if (fromDate !== undefined && toDate === fromDate) {
    toDate = addDaysToBookingDate(fromDate, 7);
  }
  copyKnownValue(normalized, "fromDate", fromDate);
  copyKnownValue(normalized, "toDate", toDate);

  copyKnownValue(normalized, "slotDate", toolArguments?.slotDate ?? session.workflowState?.context?.slotDate);
  copyKnownValue(normalized, "slotTime", toolArguments?.slotTime ?? session.workflowState?.context?.slotTime);

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

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
