import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { normalizeAppointmentId } from "../../appointments/appointmentId.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { ConfirmAppointmentToolAdapter } from "./confirmAppointmentToolAdapter.js";
import { createConfirmAppointmentTurnContext } from "./confirmAppointmentTurnContext.js";

const toolAdapter = new ConfirmAppointmentToolAdapter();

export const confirmAppointmentWorkflow: ConversationWorkflow = {
  name: "CONFIRM_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    return applyConfirmationExecutionBoundary(session, result);
  }
};

function applyConfirmationExecutionBoundary(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision | undefined {
  if (!isConfirmIntent(session.currentIntent) || !isFallbackToolRequest(result.toolRequest?.name)) {
    return undefined;
  }

  const context = createConfirmAppointmentTurnContext(session, result);
  if (context.pendingConfirmationStatus === "READY_TO_EXECUTE") {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {
            appointmentId: session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId,
            callerConfirmedSelectedAppointment: true
          }
        }
      }
    };
  }

  if (context.pendingSelection) {
    return {
      repromptContext: {
        type: "CONFIRM_SELECTED_APPOINTMENT",
        selectedAppointment: {
          appointmentId: context.pendingSelection.appointmentId,
          appointmentDate: context.pendingSelection.appointmentDate,
          doctorName: context.pendingSelection.doctorName
        }
      }
    };
  }

  if (context.selectionOptions.length > 0) {
    return {
      repromptContext: {
        type: "CHOOSE_CONFIRMABLE_APPOINTMENT",
        options: context.selectionOptions.map((option) => ({
          appointmentId: option.appointmentId,
          appointmentDate: option.appointmentDate,
          doctorName: option.doctorName
        }))
      }
    };
  }

  return undefined;
}

function isConfirmIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "CONFIRM_APPOINTMENT";
}

function isFallbackToolRequest(toolName: string | undefined): boolean {
  return toolName === "TRANSFER_TO_STAFF" || toolName === "CREATE_HANDOFF_REQUEST";
}
