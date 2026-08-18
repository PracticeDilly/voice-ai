import { ToolRequest, ToolResult } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";

export function syncPendingAppointmentConfirmation(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult,
  activeIntent: string | undefined
): void {
  if (toolName !== "GET_NEXT_APPOINTMENT" || !isConfirmIntent(activeIntent) || toolResult.ok !== true) {
    return;
  }

  const appointmentId = resolvedAppointmentId(toolResult);
  if (!appointmentId || alreadyConfirmed(toolResult)) {
    delete session.pendingActions.CONFIRM_APPOINTMENT;
    return;
  }

  session.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: new Date().toISOString()
  };
}

export function promotePendingAppointmentConfirmation(session: CallSession, tool?: ToolRequest): void {
  const pending = session.pendingActions.CONFIRM_APPOINTMENT;
  if (!pending || !callerConfirmedSelectedAppointment(session, tool)) {
    return;
  }

  pending.status = "READY_TO_EXECUTE";
}

export function consumePendingAppointmentConfirmation(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult
): void {
  if (toolName === "CONFIRM_APPOINTMENT" && toolResult.ok === true) {
    delete session.pendingActions.CONFIRM_APPOINTMENT;
    delete session.collectedFields.callerConfirmedSelectedAppointment;
  }
}

export function pendingAppointmentConfirmationError(session: CallSession, tool: ToolRequest): string | undefined {
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

export function prepareAppointmentConfirmation(session: CallSession, tool: ToolRequest): ToolRequest {
  if (tool.name !== "CONFIRM_APPOINTMENT" || pendingAppointmentConfirmationError(session, tool)) {
    return tool;
  }

  return {
    ...tool,
    arguments: {
      ...tool.arguments,
      callerConfirmedSelectedAppointment: true
    }
  };
}

function isConfirmIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "CONFIRM_APPOINTMENT";
}

function callerConfirmedSelectedAppointment(session: CallSession, tool: ToolRequest | undefined): boolean {
  return session.collectedFields.callerConfirmedSelectedAppointment === true
    || (tool?.name === "CONFIRM_APPOINTMENT" && tool.arguments?.callerConfirmedSelectedAppointment === true);
}

function resolvedAppointmentId(toolResult: ToolResult): unknown {
  const data = asRecord(toolResult.data);
  const workflowContext = asRecord(asRecord(data?.workflowState)?.context);
  return data?.appointmentId ?? workflowContext?.selectedAppointmentId;
}

function alreadyConfirmed(toolResult: ToolResult): boolean {
  const data = asRecord(toolResult.data);
  const metadata = asRecord(data?.metadata);
  const workflowContext = asRecord(asRecord(data?.workflowState)?.context);
  return data?.alreadyConfirmed === true
    || metadata?.alreadyConfirmed === true
    || workflowContext?.alreadyConfirmed === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeAppointmentId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const normalized = BigInt(value.trim());
    return normalized > 0n ? normalized.toString() : undefined;
  }

  return undefined;
}
