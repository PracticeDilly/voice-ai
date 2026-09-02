import type { ModelTurnResult } from "../../conversation/modelClient.js";

export type SpeechAct =
  | "QUESTION"
  | "REQUEST"
  | "AUTHORIZATION"
  | "CORRECTION"
  | "ACKNOWLEDGEMENT"
  | "GOODBYE"
  | "UNKNOWN";

export type WorkflowIntent =
  | "NEXT_APPOINTMENT"
  | "CONFIRM_APPOINTMENT"
  | "TRANSFER_TO_STAFF"
  | "OFFICE_INFORMATION"
  | "UNKNOWN";

export type RequestedAction =
  | "LOOKUP_APPOINTMENTS"
  | "CONFIRM_SELECTED_APPOINTMENT"
  | "TRANSFER_TO_STAFF"
  | "NONE";

export interface CallerActionAuthorization {
  stateChangingAction?: "CONFIRM_APPOINTMENT" | null;
  isExplicit?: boolean;
  selectedAppointmentReference?: Record<string, unknown> | null;
}

export interface CallerActionDecision {
  speechAct?: SpeechAct;
  workflowIntent?: WorkflowIntent;
  requestedAction?: RequestedAction;
  authorization?: CallerActionAuthorization;
}

export function callerActionRequestsStaffTransfer(result: ModelTurnResult): boolean {
  return result.callerAction?.requestedAction === "TRANSFER_TO_STAFF"
    || result.callerAction?.workflowIntent === "TRANSFER_TO_STAFF";
}

export function callerActionExplicitlyAuthorizesConfirmation(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.authorization?.stateChangingAction === "CONFIRM_APPOINTMENT"
    && result.callerAction.authorization.isExplicit === true;
}

export function callerActionIsConfirmationQuestion(result: ModelTurnResult): boolean {
  return result.callerAction?.speechAct === "QUESTION"
    && (
      result.callerAction.workflowIntent === "CONFIRM_APPOINTMENT"
      || result.callerAction.requestedAction === "CONFIRM_SELECTED_APPOINTMENT"
    );
}
