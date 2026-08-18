import { ToolRequest, ToolResult } from "../backend/springBootClient.js";
import { AppointmentSelectionOption, CallSession } from "../calls/callSession.js";

export function syncPendingAppointmentConfirmation(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult,
  activeIntent: string | undefined
): void {
  if (toolName !== "GET_NEXT_APPOINTMENT" || !isConfirmIntent(activeIntent) || toolResult.ok !== true) {
    return;
  }

  const options = confirmableAppointmentOptions(toolResult);
  if (options.length > 1) {
    session.appointmentSelections.CONFIRM_APPOINTMENT = {
      options,
      createdAt: new Date().toISOString()
    };
    delete session.pendingActions.CONFIRM_APPOINTMENT;
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

export function syncAppointmentConfirmationOptionsFromLastLookup(session: CallSession): void {
  if (!isConfirmIntent(session.currentIntent) || session.appointmentSelections.CONFIRM_APPOINTMENT) {
    return;
  }

  const lastLookup = asToolResult(session.lastToolResults.GET_NEXT_APPOINTMENT);
  if (!lastLookup || lastLookup.ok !== true) {
    return;
  }

  const options = confirmableAppointmentOptions(lastLookup);
  if (options.length === 0) {
    return;
  }

  session.appointmentSelections.CONFIRM_APPOINTMENT = {
    options,
    createdAt: new Date().toISOString()
  };
}

export function promotePendingAppointmentConfirmation(session: CallSession, tool?: ToolRequest): void {
  syncSelectedAppointmentConfirmation(session, tool);

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
    delete session.appointmentSelections.CONFIRM_APPOINTMENT;
    delete session.collectedFields.callerConfirmedSelectedAppointment;
    delete session.collectedFields.selectedAppointmentId;
    delete session.collectedFields.selectedAppointmentDate;
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

  if (pendingAppointmentConfirmationError(session, withPendingAppointment)) {
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

function isConfirmIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "CONFIRM_APPOINTMENT";
}

function syncSelectedAppointmentConfirmation(session: CallSession, tool: ToolRequest | undefined): void {
  if (!isConfirmIntent(session.currentIntent)) {
    return;
  }

  const option = selectedConfirmationOption(session, tool);
  if (!option) {
    return;
  }

  const selectedAppointmentId = normalizeAppointmentId(option.appointmentId);
  const pendingAppointmentId = normalizeAppointmentId(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId);
  if (!selectedAppointmentId || selectedAppointmentId === pendingAppointmentId) {
    return;
  }

  session.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: option.appointmentId,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: new Date().toISOString()
  };
}

function selectedConfirmationOption(session: CallSession, tool: ToolRequest | undefined): AppointmentSelectionOption | undefined {
  const options = session.appointmentSelections.CONFIRM_APPOINTMENT?.options ?? [];
  if (options.length === 0) {
    return undefined;
  }

  const requestedId = normalizeAppointmentId(
    tool?.arguments?.appointmentId
      ?? session.collectedFields.selectedAppointmentId
      ?? session.collectedFields.appointmentId
  );
  if (requestedId) {
    return options.find((option) => normalizeAppointmentId(option.appointmentId) === requestedId);
  }

  const selectedDate = normalizedText(session.collectedFields.selectedAppointmentDate ?? tool?.arguments?.selectedAppointmentDate);
  if (selectedDate) {
    const matches = options.filter((option) => normalizedText(option.appointmentDate) === selectedDate);
    return matches.length === 1 ? matches[0] : undefined;
  }

  return undefined;
}

function callerConfirmedSelectedAppointment(session: CallSession, tool: ToolRequest | undefined): boolean {
  return session.collectedFields.callerConfirmedSelectedAppointment === true
    || (tool?.name === "CONFIRM_APPOINTMENT" && tool.arguments?.callerConfirmedSelectedAppointment === true);
}

function confirmableAppointmentOptions(toolResult: ToolResult): AppointmentSelectionOption[] {
  const data = asRecord(toolResult.data);
  const workflowContext = asRecord(asRecord(data?.workflowState)?.context);
  const candidates = firstArray(
    data?.upcomingAppointments,
    data?.appointments,
    workflowContext?.appointments
  );

  return candidates
    .map(asRecord)
    .filter((candidate): candidate is Record<string, unknown> => !!candidate)
    .map((candidate) => ({
      appointmentId: candidate.appointmentId,
      appointmentDate: stringValue(candidate.appointmentDate),
      doctorName: stringValue(candidate.doctorName),
      alreadyConfirmed: candidate.alreadyConfirmed === true,
      source: candidate
    }))
    .filter((option) => !!normalizeAppointmentId(option.appointmentId) && option.alreadyConfirmed !== true);
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

function asToolResult(value: unknown): ToolResult | undefined {
  const record = asRecord(value);
  if (!record || typeof record.ok !== "boolean") {
    return undefined;
  }

  return record as unknown as ToolResult;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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
