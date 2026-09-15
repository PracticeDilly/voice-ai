import { CallSession } from "../../calls/callSession.js";
import { normalizeBookingDatePreference } from "./bookingDatePreference.js";
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
  copyKnownValue(
    normalized,
    "dob",
    toolArguments?.dob
      ?? toolArguments?.dateOfBirth
      ?? session.collectedFields.dob
      ?? session.collectedFields.dateOfBirth
  );
  applySingleOfficeContextProvider(normalized, session);

  copyKnownValue(normalized, "fromNumber", normalized.fromNumber ?? session.fromNumber);

  const datePreference = normalizeBookingDatePreference(
    normalized.datePreference,
    session.officeContext?.timezone,
    session.startedAt
  );
  copyKnownValue(normalized, "datePreference", datePreference);

  const hasToolDatePreference = hasValue(toolArguments?.datePreference);
  const hasToolFromDate = hasValue(toolArguments?.fromDate);
  const hasToolToDate = hasValue(toolArguments?.toDate);
  const fromDateInput = hasToolDatePreference && !hasToolFromDate
    ? normalized.datePreference
    : normalized.fromDate ?? normalized.datePreference;
  const toDateInput = hasToolToDate
    ? normalized.toDate
    : (hasToolDatePreference || hasToolFromDate)
      ? fromDateInput
      : normalized.toDate ?? fromDateInput;
  const fromDate = normalizeBookingDatePreference(
    fromDateInput,
    session.officeContext?.timezone,
    session.startedAt
  );
  const toDate = normalizeBookingDatePreference(
    toDateInput ?? fromDate,
    session.officeContext?.timezone,
    session.startedAt
  );
  copyKnownValue(normalized, "fromDate", fromDate);
  copyKnownValue(normalized, "toDate", toDate);

  copyKnownValue(normalized, "slotDate", toolArguments?.slotDate ?? session.workflowState?.context?.slotDate);
  copyKnownValue(normalized, "slotTime", toolArguments?.slotTime ?? session.workflowState?.context?.slotTime);

  return normalized;
}

function copyKnownValue(target: Record<string, unknown>, fieldName: string, value: unknown): void {
  if (fieldName === "patientPhone" && isPlaceholderPhoneValue(value)) {
    return;
  }
  if (value !== undefined && value !== null && value !== "") {
    target[fieldName] = value;
  }
}

function isPlaceholderPhoneValue(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return ["fromnumber", "patientphone", "true", "false", "null", "undefined"]
    .includes(value.trim().toLowerCase());
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
