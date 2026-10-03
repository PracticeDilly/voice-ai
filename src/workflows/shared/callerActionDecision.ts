import type { ModelTurnResult } from "../../conversation/modelClient.js";

export type SpeechAct =
  | "QUESTION"
  | "REQUEST"
  | "AUTHORIZATION"
  | "DECLINE"
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

export type PatientTypeChoice = "NEW_PATIENT" | "RETURNING_PATIENT";
export type BookingPatientSubjectChoice = "CALLER" | "SOMEONE_ELSE";

export interface CallerActionAuthorization {
  stateChangingAction?: "CONFIRM_APPOINTMENT" | "BOOK_APPOINTMENT" | "CONTINUE_AS_NEW_PATIENT" | "TRANSFER_TO_STAFF" | null;
  isExplicit?: boolean;
  selectedAppointmentReference?: Record<string, unknown> | null;
}

export interface CallerActionDecision {
  speechAct?: SpeechAct;
  workflowIntent?: WorkflowIntent;
  requestedAction?: RequestedAction;
  bookingPatientSubjectChoice?: BookingPatientSubjectChoice | null;
  patientTypeChoice?: PatientTypeChoice | null;
  authorization?: CallerActionAuthorization;
}

export function callerActionRequestsStaffTransfer(result?: ModelTurnResult): boolean {
  const action = result?.callerAction;
  if (!action || (action.requestedAction !== "TRANSFER_TO_STAFF"
      && action.workflowIntent !== "TRANSFER_TO_STAFF")) {
    return false;
  }

  return action.speechAct === "REQUEST"
    || (action.speechAct === "AUTHORIZATION" && action.authorization?.isExplicit === true);
}

export function callerTextRequestsStaffTransfer(callerText: string): boolean {
  const normalized = callerText.trim().toLocaleLowerCase();
  if (!normalized) {
    return false;
  }

  return /\b(?:talk|speak|connect|transfer|put me|let me)\b.{0,40}\b(?:office staff|staff|live agent|representative|human|someone)\b/.test(normalized)
    || /\b(?:office staff|live agent|representative|human|someone)\b.{0,40}\b(?:talk|speak|connect|transfer)\b/.test(normalized);
}

export function callerActionExplicitlyAuthorizesStaffTransfer(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.authorization?.stateChangingAction === "TRANSFER_TO_STAFF"
    && result.callerAction.authorization.isExplicit === true;
}

export function callerActionDeclinesStaffTransfer(result?: ModelTurnResult): boolean {
  // The caller is answering a pending transfer offer; the broader workflow
  // intent may still be NEXT_APPOINTMENT or BOOK_APPOINTMENT.
  return result?.callerAction?.speechAct === "DECLINE"
    && (!result.callerAction.requestedAction || result.callerAction.requestedAction === "NONE"
      || result.callerAction.requestedAction === "TRANSFER_TO_STAFF");
}

export function callerActionEndsConversation(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "GOODBYE"
    && !result.toolRequest
    && (!result.callerAction.requestedAction || result.callerAction.requestedAction === "NONE");
}

export function callerTextAsksOfficeHours(callerText: string): boolean {
  const normalized = callerText.trim().toLocaleLowerCase();
  if (!normalized) {
    return false;
  }

  return /\b(?:office|opening|business|working) hours?\b/.test(normalized)
    || /\bwhen are you open\b/.test(normalized)
    || /\bwhat time can i visit\b/.test(normalized)
    || /\bwhat time do you open\b/.test(normalized)
    || /\bwhat time do you close\b/.test(normalized);
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

export function callerActionAuthorizesNextAvailabilityLookup(result?: ModelTurnResult): boolean {
  return result?.callerAction?.speechAct === "AUTHORIZATION"
    && result.callerAction.workflowIntent === "NEXT_APPOINTMENT"
    && result.callerAction.requestedAction === "LOOKUP_APPOINTMENTS";
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

export function callerDeclinesFurtherAssistance(callerText: string, previousAssistantText: string): boolean {
  const normalizedCallerText = callerText.trim().toLocaleLowerCase();
  const assistantAskedForMoreHelp = /\b(?:anything else|anything more|any further (?:help|assistance)|anything i can help you with)\b/i
    .test(previousAssistantText);

  if (!assistantAskedForMoreHelp) {
    return false;
  }

  return /^(?:no(?:[\s,.!?]+(?:thank you|thanks))?|nothing else|that is all|that's all|i am all set|i'm all set|i am good|i'm good)[\s,.!?]*$/i
    .test(normalizedCallerText);
}

export function callerActionIsConfirmationQuestion(result: ModelTurnResult): boolean {
  return result.callerAction?.speechAct === "QUESTION"
    && (
      result.callerAction.workflowIntent === "CONFIRM_APPOINTMENT"
      || result.callerAction.requestedAction === "CONFIRM_SELECTED_APPOINTMENT"
    );
}
