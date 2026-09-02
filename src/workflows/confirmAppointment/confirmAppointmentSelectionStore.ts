import { AppointmentSelectionOption, CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import { ToolResult } from "../../backend/springBootClient.js";
import { normalizeAppointmentId } from "../../appointments/appointmentId.js";

export function storeConfirmAppointmentOptionsFromLookup(session: CallSession, toolResult: ToolResult): void {
  const options = confirmableAppointmentOptions(toolResult);
  if (options.length === 0) {
    return;
  }

  session.appointmentSelections.CONFIRM_APPOINTMENT = {
    options,
    createdAt: new Date().toISOString()
  };
}

export function hydrateConfirmAppointmentOptionsFromLastLookup(session: CallSession): void {
  if (!isConfirmIntent(session.currentIntent) || session.appointmentSelections.CONFIRM_APPOINTMENT) {
    return;
  }

  const lastLookup = asToolResult(session.lastToolResults.GET_NEXT_APPOINTMENT);
  if (!lastLookup || lastLookup.ok !== true) {
    return;
  }

  storeConfirmAppointmentOptionsFromLookup(session, lastLookup);
}

export function selectedConfirmAppointmentOption(
  session: CallSession,
  toolArguments?: Record<string, unknown>,
  result?: ModelTurnResult
): AppointmentSelectionOption | undefined {
  const options = session.appointmentSelections.CONFIRM_APPOINTMENT?.options ?? [];
  if (options.length === 0) {
    return undefined;
  }

  const requestedId = normalizeAppointmentId(
    toolArguments?.appointmentId
      ?? toolArguments?.selectedAppointmentId
      ?? session.collectedFields.selectedAppointmentId
      ?? session.collectedFields.appointmentId
      ?? selectedAppointmentReferenceValue(result, "appointmentId")
      ?? selectedAppointmentReferenceValue(result, "id")
  );
  if (requestedId) {
    const optionById = options.find((option) => normalizeAppointmentId(option.appointmentId) === requestedId);
    if (optionById) {
      return optionById;
    }
  }

  const appointmentReference = [
    toolArguments?.appointmentDate,
    toolArguments?.appointmentTime,
    session.collectedFields.selectedAppointmentDate,
    session.collectedFields.appointmentDate,
    selectedAppointmentReferenceValue(result, "appointmentDate"),
    selectedAppointmentReferenceValue(result, "date"),
    selectedAppointmentReferenceValue(result, "time")
  ].filter(isMeaningfulString);
  if (appointmentReference.length > 0) {
    return options.find((option) => appointmentReferenceMatchesOption(appointmentReference, option));
  }

  return undefined;
}

export function pendingConfirmationSelection(session: CallSession): AppointmentSelectionOption | undefined {
  const pendingAppointmentId = normalizeAppointmentId(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId);
  if (!pendingAppointmentId) {
    return undefined;
  }

  return session.appointmentSelections.CONFIRM_APPOINTMENT?.options.find((option) =>
    normalizeAppointmentId(option.appointmentId) === pendingAppointmentId
  );
}

export function resolveLookupAppointmentId(toolResult: ToolResult): unknown {
  const data = asRecord(toolResult.data);
  const workflowContext = asRecord(asRecord(data?.workflowState)?.context);
  return data?.appointmentId ?? workflowContext?.selectedAppointmentId;
}

export function lookupAlreadyConfirmed(toolResult: ToolResult): boolean {
  const data = asRecord(toolResult.data);
  const metadata = asRecord(data?.metadata);
  const workflowContext = asRecord(asRecord(data?.workflowState)?.context);
  return data?.alreadyConfirmed === true
    || metadata?.alreadyConfirmed === true
    || workflowContext?.alreadyConfirmed === true;
}

export function confirmableAppointmentOptions(toolResult: ToolResult): AppointmentSelectionOption[] {
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

function isConfirmIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "CONFIRM_APPOINTMENT";
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

function selectedAppointmentReferenceValue(result: ModelTurnResult | undefined, key: string): unknown {
  return result?.callerAction?.authorization?.selectedAppointmentReference?.[key];
}

function appointmentReferenceMatchesOption(
  references: string[],
  option: AppointmentSelectionOption
): boolean {
  const appointmentDate = normalizeText(option.appointmentDate);
  if (!appointmentDate) {
    return false;
  }

  return references.some((reference) => {
    const normalizedReference = normalizeText(reference);
    return !!normalizedReference
      && (appointmentDate.includes(normalizedReference) || normalizedReference.includes(appointmentDate));
  });
}

function normalizeText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isMeaningfulString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
