import { z } from "zod";
import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";

const textField = z.string().nullable().optional();
export class BookingWorkflowError extends Error {}

const bookingFields = z.object({
  firstName: textField,
  lastName: textField,
  dob: textField,
  fromNumber: textField,
  bookingReason: textField,
  appointmentTypeId: z.number().int().positive().nullable().optional(),
  providerName: textField,
  datePreference: textField,
  timePreference: textField,
  slotDate: textField,
  slotTime: textField,
  callerConfirmedBooking: z.boolean().nullable().optional()
}).strict();

const requiredBookingToolFields = ["firstName", "dob", "bookingReason", "appointmentTypeId"] as const;

export function bookingModelContractError(session: CallSession, result: ModelTurnResult): string | undefined {
  if (result.toolRequest?.name === "TRANSFER_TO_STAFF") return undefined;
  if (result.toolRequest?.name === "BOOK_APPOINTMENT") {
    const fieldsError = validateBookingArguments(result.toolRequest.arguments);
    if (fieldsError) return fieldsError;

    const fields = mergedBookingFields(session, result);
    for (const field of requiredBookingToolFields) {
      if (isBlank(fields[field])) {
        return `BOOK_APPOINTMENT is missing ${field}.`;
      }
    }
    return undefined;
  }

  const requiredField = session.workflowState?.requiredField;
  if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && session.workflowState.state === "NEEDS_PATIENT_IDENTITY"
    && !result.toolRequest
    && (!result.intent || result.intent.toUpperCase() === "BOOK_APPOINTMENT")
    && requiredField
    && !isBlank(mergedBookingFields(session, result)[requiredField])) {
    return `Backend requiredField ${requiredField} is already known but has not been submitted.`;
  }

  return undefined;
}

function validateBookingArguments(fields: unknown): string | undefined {
  if (!fields) return undefined;

  const validation = bookingFields.safeParse(fields);
  if (validation.success) return undefined;

  const issues = validation.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return `BOOK_APPOINTMENT arguments violate the contract: ${issues}`;
}

function mergedBookingFields(session: CallSession, result: ModelTurnResult): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...session.collectedFields };
  for (const source of [result.collectedFields, result.toolRequest?.arguments]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (!isBlank(value)) fields[name] = value;
    }
  }
  return fields;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
