import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { WorkflowStateView } from "../shared/workflowStateView.js";
import { ConfirmAppointmentStateView } from "./confirmAppointmentStateView.js";
import { pendingConfirmationSelection } from "./confirmAppointmentSelectionStore.js";

export interface ConfirmAppointmentTurnContext {
  session: CallSession;
  result: ModelTurnResult;
  stateView: ConfirmAppointmentStateView;
  pendingConfirmationStatus?: "AWAITING_CALLER_CONFIRMATION" | "READY_TO_EXECUTE";
  pendingSelection?: ReturnType<typeof pendingConfirmationSelection>;
  selectionOptions: NonNullable<CallSession["appointmentSelections"]["CONFIRM_APPOINTMENT"]>["options"];
}

export function createConfirmAppointmentTurnContext(
  session: CallSession,
  result: ModelTurnResult
): ConfirmAppointmentTurnContext {
  return {
    session,
    result,
    stateView: new ConfirmAppointmentStateView(new WorkflowStateView(session.workflowState)),
    pendingConfirmationStatus: session.pendingActions.CONFIRM_APPOINTMENT?.status,
    pendingSelection: pendingConfirmationSelection(session),
    selectionOptions: session.appointmentSelections.CONFIRM_APPOINTMENT?.options ?? []
  };
}
