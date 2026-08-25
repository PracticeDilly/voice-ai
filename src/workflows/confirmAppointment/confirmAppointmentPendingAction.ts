import { ToolRequest, ToolResult } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { normalizeAppointmentId } from "../../appointments/appointmentId.js";
import {
  hydrateConfirmAppointmentOptionsFromLastLookup,
  lookupAlreadyConfirmed,
  pendingConfirmationSelection,
  resolveLookupAppointmentId,
  selectedConfirmAppointmentOption,
  storeConfirmAppointmentOptionsFromLookup
} from "./confirmAppointmentSelectionStore.js";

export function syncConfirmAppointmentFromLookup(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult,
  activeIntent: string | undefined
): void {
  if (toolName !== "GET_NEXT_APPOINTMENT" || !isConfirmIntent(activeIntent) || toolResult.ok !== true) {
    return;
  }

  const options = storeAndReadOptions(session, toolResult);
  if (options.length > 1) {
    delete session.pendingActions.CONFIRM_APPOINTMENT;
    return;
  }

  const appointmentId = resolveLookupAppointmentId(toolResult);
  if (!appointmentId || lookupAlreadyConfirmed(toolResult)) {
    delete session.pendingActions.CONFIRM_APPOINTMENT;
    return;
  }

  session.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: new Date().toISOString()
  };
}

export function hydrateConfirmAppointmentSelections(session: CallSession): void {
  hydrateConfirmAppointmentOptionsFromLastLookup(session);
}

export function promoteConfirmAppointmentPendingAction(session: CallSession, tool?: ToolRequest): void {
  const selectedInCurrentTurn = syncSelectedConfirmAppointment(session, tool);

  const pending = session.pendingActions.CONFIRM_APPOINTMENT;
  if (!pending || !callerAuthorizedSelectedAppointment(session, selectedInCurrentTurn)) {
    return;
  }

  pending.status = "READY_TO_EXECUTE";
}

export function consumeConfirmAppointmentPendingAction(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult
): void {
  if (toolName === "CONFIRM_APPOINTMENT" && toolResult.ok === true) {
    delete session.pendingActions.CONFIRM_APPOINTMENT;
    delete session.appointmentSelections.CONFIRM_APPOINTMENT;
    delete session.collectedFields.callerConfirmedSelectedAppointment;
    delete session.collectedFields.selectedAppointmentId;
    delete session.collectedFields.selectedAppointmentDate;
  }
}

export function confirmAppointmentPendingError(session: CallSession, tool: ToolRequest): string | undefined {
  if (tool.name !== "CONFIRM_APPOINTMENT") {
    return undefined;
  }

  const pending = session.pendingActions.CONFIRM_APPOINTMENT;
  if (!pending) {
    return "Appointment confirmation requires a pending confirmation action.";
  }

  if (pending.status !== "READY_TO_EXECUTE") {
    return "Appointment confirmation requires explicit caller confirmation.";
  }

  const pendingAppointmentId = normalizeAppointmentId(pending.appointmentId);
  const requestedAppointmentId = normalizeAppointmentId(tool.arguments?.appointmentId);
  if (!pendingAppointmentId || !requestedAppointmentId || pendingAppointmentId !== requestedAppointmentId) {
    return "The requested appointment does not match the pending confirmation action.";
  }

  return undefined;
}

export function prepareConfirmAppointmentTool(session: CallSession, tool: ToolRequest): ToolRequest {
  if (tool.name !== "CONFIRM_APPOINTMENT") {
    return tool;
  }

  const pending = session.pendingActions.CONFIRM_APPOINTMENT;
  const withPendingAppointment = pending
    ? {
        ...tool,
        arguments: {
          ...tool.arguments,
          appointmentId: tool.arguments?.appointmentId ?? pending.appointmentId
        }
      }
    : tool;

  if (confirmAppointmentPendingError(session, withPendingAppointment)) {
    return withPendingAppointment;
  }

  return {
    ...withPendingAppointment,
    arguments: {
      ...withPendingAppointment.arguments,
      callerConfirmedSelectedAppointment: true
    }
  };
}

function syncSelectedConfirmAppointment(session: CallSession, tool: ToolRequest | undefined): boolean {
  if (!isConfirmIntent(session.currentIntent)) {
    return false;
  }

  const option = selectedConfirmAppointmentOption(session, tool?.arguments);
  if (!option) {
    return false;
  }

  const selectedAppointmentId = normalizeAppointmentId(option.appointmentId);
  const pendingAppointmentId = normalizeAppointmentId(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId);
  if (!selectedAppointmentId || selectedAppointmentId === pendingAppointmentId) {
    return false;
  }

  session.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: option.appointmentId,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: new Date().toISOString()
  };
  return true;
}

function callerAuthorizedSelectedAppointment(
  session: CallSession,
  selectedInCurrentTurn: boolean
): boolean {
  return session.collectedFields.callerConfirmedSelectedAppointment === true
    || selectedInCurrentTurn;
}

function isConfirmIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "CONFIRM_APPOINTMENT";
}

function storeAndReadOptions(session: CallSession, toolResult: ToolResult) {
  storeConfirmAppointmentOptionsFromLookup(session, toolResult);
  return session.appointmentSelections.CONFIRM_APPOINTMENT?.options ?? [];
}
