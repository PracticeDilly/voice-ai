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
  | "BOOK_APPOINTMENT"
  | "TRANSFER_TO_STAFF"
  | "OFFICE_INFORMATION"
  | "UNKNOWN";

export type RequestedAction =
  | "LOOKUP_APPOINTMENTS"
  | "CONFIRM_SELECTED_APPOINTMENT"
  | "BOOK_APPOINTMENT"
  | "TRANSFER_TO_STAFF"
  | "NONE";

export interface CallerActionAuthorization {
  stateChangingAction?: "CONFIRM_APPOINTMENT" | "BOOK_APPOINTMENT" | "CONTINUE_AS_NEW_PATIENT" | null;
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
  const action = result.callerAction;
  if (!action || (action.requestedAction !== "TRANSFER_TO_STAFF"
      && action.workflowIntent !== "TRANSFER_TO_STAFF")) {
    return false;
  }

  return action.speechAct === "REQUEST"
    || (action.speechAct === "AUTHORIZATION" && action.authorization?.isExplicit === true);
}

export function callerActionExplicitlyAuthorizesConfirmation(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.authorization?.stateChangingAction === "CONFIRM_APPOINTMENT"
    && result.callerAction.authorization.isExplicit === true;
}

export function callerActionExplicitlyAuthorizesBooking(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.authorization?.stateChangingAction === "BOOK_APPOINTMENT"
    && result.callerAction.authorization.isExplicit === true;
}

export function callerActionExplicitlyAuthorizesNewPatient(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.authorization?.stateChangingAction === "CONTINUE_AS_NEW_PATIENT"
    && result.callerAction.authorization.isExplicit === true;
}

export function callerTextExplicitlyContinuesAsNewPatient(
  callerText: string,
  previousAssistantText?: string
): boolean {
  const normalized = callerText.trim().toLocaleLowerCase();
  if (!normalized || /\b(?:don't|do not|not|never)\b.{0,24}\bnew patient\b/.test(normalized)) {
    return false;
  }

  const explicitNewPatientChoice = /\b(?:continue|proceed|book|schedule|register|create|come|visit)\b.{0,36}\b(?:as )?a new patient\b/.test(normalized)
    || /\bnew patient\b.{0,36}\b(?:continue|proceed|book|schedule|register|create|come|visit)\b/.test(normalized);
  if (explicitNewPatientChoice) {
    return true;
  }

  return /^(?:yes|yeah|yep|sure|okay|ok|correct|that's fine|that works)[\s,.!?]*$/i.test(callerText.trim())
    && /\b(?:continue as a new patient|new patient or speak with office staff|new patient)\b/i.test(previousAssistantText ?? "");
}

export function callerExplicitlyEndsCall(callerText: string): boolean {
  const normalized = callerText.trim().toLocaleLowerCase();
  if (!normalized) {
    return false;
  }

  return /\b(?:drop|end|hang up|disconnect|terminate|close)\b.{0,24}\b(?:the )?(?:call|conversation|phone)\b/.test(normalized)
    || /\b(?:call|conversation)\b.{0,24}\b(?:over|ended|finished)\b/.test(normalized)
    || /^(?:goodbye|bye|that's all|that is all)[\s,.!?]*$/i.test(callerText.trim());
}

export function callerActionIsConfirmationQuestion(result: ModelTurnResult): boolean {
  return result.callerAction?.speechAct === "QUESTION"
    && (
      result.callerAction.workflowIntent === "CONFIRM_APPOINTMENT"
      || result.callerAction.requestedAction === "CONFIRM_SELECTED_APPOINTMENT"
    );
}
