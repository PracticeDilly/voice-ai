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
  if (!isConfirmIntent(session.currentIntent)) {
    return undefined;
  }

  const context = createConfirmAppointmentTurnContext(session, result);
  if (context.pendingConfirmationStatus === "READY_TO_EXECUTE" && result.toolRequest?.name !== "CONFIRM_APPOINTMENT") {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {
            appointmentId: session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId
          }
        }
      }
    };
  }

  if (context.pendingSelection) {
    return {
      instruction: "A confirmation execution boundary is active. Continue the confirmation workflow using the provided boundary context. Stay with appointment selection and confirmation. Do not use fallback staff transfer or follow-up unless the caller explicitly asks for staff or the backend requires handoff.",
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
      instruction: "A confirmation execution boundary is active. Continue the confirmation workflow using the provided boundary context. Help the caller choose one confirmable appointment before any state-changing tool request. Do not use fallback staff transfer or follow-up unless the caller explicitly asks for staff or the backend requires handoff.",
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
