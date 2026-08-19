import { CallSession } from "../calls/callSession.js";
import { normalizeAppointmentId } from "../appointments/appointmentId.js";
import { ModelTurnResult } from "./modelClient.js";

export interface ToolPolicyBoundaryContext {
  type: "CONFIRM_SELECTED_APPOINTMENT" | "CHOOSE_CONFIRMABLE_APPOINTMENT";
  selectedAppointment?: {
    appointmentId: unknown;
    appointmentDate?: string;
    doctorName?: string;
  };
  options?: Array<{
    appointmentId: unknown;
    appointmentDate?: string;
    doctorName?: string;
  }>;
}

export interface ToolPolicyDecision {
  overrideResult?: ModelTurnResult;
  repromptContext?: ToolPolicyBoundaryContext;
}

export function applyDeterministicToolPolicy(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision {
  const confirmationBoundaryDecision = applyConfirmationExecutionBoundary(session, result);
  if (confirmationBoundaryDecision) {
    return confirmationBoundaryDecision;
  }

  if (shouldRefreshAppointmentsAfterConfirmation(session, result)) {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "GET_NEXT_APPOINTMENT",
          arguments: { ...session.collectedFields }
        }
      }
    };
  }

  if (shouldRetryLookupInsteadOfHandoff(session, result)) {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "GET_NEXT_APPOINTMENT",
          arguments: {
            ...session.collectedFields,
            ...(result.collectedFields ?? {})
          }
        }
      }
    };
  }

  return {
    overrideResult: result
  };
}

function applyConfirmationExecutionBoundary(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision | undefined {
  if (!isConfirmIntent(session.currentIntent) || !isFallbackToolRequest(result.toolRequest?.name)) {
    return undefined;
  }

  const pendingConfirmation = session.pendingActions.CONFIRM_APPOINTMENT;
  if (pendingConfirmation?.status === "READY_TO_EXECUTE") {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {
            appointmentId: pendingConfirmation.appointmentId,
            callerConfirmedSelectedAppointment: true
          }
        }
      }
    };
  }

  const selectedOption = selectedConfirmationOption(session);
  if (selectedOption) {
    return {
      repromptContext: {
        type: "CONFIRM_SELECTED_APPOINTMENT",
        selectedAppointment: {
          appointmentId: selectedOption.appointmentId,
          appointmentDate: selectedOption.appointmentDate,
          doctorName: selectedOption.doctorName
        }
      }
    };
  }

  const options = session.appointmentSelections.CONFIRM_APPOINTMENT?.options ?? [];
  if (options.length > 0) {
    return {
      repromptContext: {
        type: "CHOOSE_CONFIRMABLE_APPOINTMENT",
        options: options.map((option) => ({
          appointmentId: option.appointmentId,
          appointmentDate: option.appointmentDate,
          doctorName: option.doctorName
        }))
      }
    };
  }

  return undefined;
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

function isConfirmIntent(intent: string | undefined): boolean {
  return normalized(intent) === "CONFIRM_APPOINTMENT";
}

function isFallbackToolRequest(toolName: string | undefined): boolean {
  return toolName === "TRANSFER_TO_STAFF" || toolName === "CREATE_HANDOFF_REQUEST";
}

function selectedConfirmationOption(session: CallSession) {
  const pendingAppointmentId = normalizeAppointmentId(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId);
  if (!pendingAppointmentId) {
    return undefined;
  }

  return session.appointmentSelections.CONFIRM_APPOINTMENT?.options.find((option) =>
    normalizeAppointmentId(option.appointmentId) === pendingAppointmentId
  );
}
function isSuccessfulToolResult(toolResult: unknown): boolean {
  return typeof toolResult === "object"
    && toolResult !== null
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}
