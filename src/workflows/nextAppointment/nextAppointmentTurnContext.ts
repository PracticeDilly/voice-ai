import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { callerActionRequestsStaffTransfer } from "../shared/callerActionDecision.js";
import { WorkflowStateView } from "../shared/workflowStateView.js";
import { NextAppointmentStateView } from "./nextAppointmentStateView.js";

export interface NextAppointmentTurnContext {
  session: CallSession;
  result: ModelTurnResult;
  stateView: NextAppointmentStateView;
  requestedLookup: boolean;
  requestedHandoff: boolean;
  callerRequestedStaffTransfer: boolean;
  hasFreshLookup: boolean;
  hasSuccessfulConfirmation: boolean;
  updatedIdentityFields: Record<string, unknown>;
}

export function createNextAppointmentTurnContext(
  session: CallSession,
  result: ModelTurnResult
): NextAppointmentTurnContext {
  return {
    session,
    result,
    stateView: new NextAppointmentStateView(new WorkflowStateView(session.workflowState)),
    requestedLookup: isLookupIntent(result),
    requestedHandoff: result.toolRequest?.name === "TRANSFER_TO_STAFF",
    callerRequestedStaffTransfer: callerActionRequestsStaffTransfer(result),
    hasFreshLookup: isSuccessfulToolResult(session.lastToolResults.GET_NEXT_APPOINTMENT),
    hasSuccessfulConfirmation: isSuccessfulToolResult(session.lastToolResults.CONFIRM_APPOINTMENT),
    updatedIdentityFields: meaningfulIdentityFields(result.collectedFields ?? {})
  };
}

function isLookupIntent(result: ModelTurnResult): boolean {
  return normalized(result.intent) === "GET_NEXT_APPOINTMENT"
    || normalized(result.intent) === "NEXT_APPOINTMENT"
    || result.callerAction?.requestedAction === "LOOKUP_APPOINTMENTS"
    || result.callerAction?.workflowIntent === "NEXT_APPOINTMENT"
    || result.toolRequest?.name === "GET_NEXT_APPOINTMENT";
}

function meaningfulIdentityFields(fields: Record<string, unknown>): Record<string, unknown> {
  const firstName = meaningfulString(fields.firstName);
  const lastName = meaningfulString(fields.lastName);
  const dob = meaningfulString(fields.dob) ?? meaningfulString(fields.dateOfBirth);

  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(dob ? { dob } : {})
  };
}

function meaningfulString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
