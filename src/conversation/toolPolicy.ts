import { CallSession } from "../calls/callSession.js";
import { ModelTurnResult } from "./modelClient.js";

export function applyDeterministicToolPolicy(
  session: CallSession,
  result: ModelTurnResult
): ModelTurnResult {
  if (shouldRefreshAppointmentsAfterConfirmation(session, result)) {
    return {
      ...result,
      reply: "Let me check the latest appointment details for you.",
      toolRequest: {
        name: "GET_NEXT_APPOINTMENT",
        arguments: { ...session.collectedFields }
      }
    };
  }

  if (shouldRetryLookupInsteadOfHandoff(session, result)) {
    return {
      ...result,
      reply: "Let me try that again with the updated information.",
      toolRequest: {
        name: "GET_NEXT_APPOINTMENT",
        arguments: {
          ...session.collectedFields,
          ...(result.collectedFields ?? {})
        }
      }
    };
  }

  return result;
}

function shouldRefreshAppointmentsAfterConfirmation(
  session: CallSession,
  result: ModelTurnResult
): boolean {
  return isAppointmentLookupIntent(result)
    && result.toolRequest?.name !== "GET_NEXT_APPOINTMENT"
    && isSuccessfulToolResult(session.lastToolResults.CONFIRM_APPOINTMENT)
    && !isSuccessfulToolResult(session.lastToolResults.GET_NEXT_APPOINTMENT);
}

function shouldRetryLookupInsteadOfHandoff(
  session: CallSession,
  result: ModelTurnResult
): boolean {
  return result.toolRequest?.name === "CREATE_HANDOFF_REQUEST"
    && session.workflowState?.failureReason === "PATIENT_NOT_FOUND"
    && hasUpdatedIdentityFields(result);
}

function isAppointmentLookupIntent(result: ModelTurnResult): boolean {
  return normalized(result.intent) === "GET_NEXT_APPOINTMENT"
    || normalized(result.intent) === "NEXT_APPOINTMENT"
    || result.toolRequest?.name === "GET_NEXT_APPOINTMENT";
}

function hasUpdatedIdentityFields(result: ModelTurnResult): boolean {
  const updates = result.collectedFields ?? {};
  return hasMeaningfulValue(updates.firstName)
    || hasMeaningfulValue(updates.lastName)
    || hasMeaningfulValue(updates.dob)
    || hasMeaningfulValue(updates.dateOfBirth);
}

function hasMeaningfulValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return typeof toolResult === "object"
    && toolResult !== null
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}
