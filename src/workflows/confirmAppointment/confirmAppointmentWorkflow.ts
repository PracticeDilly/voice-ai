import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { normalizeAppointmentId } from "../../appointments/appointmentId.js";
import { retryToolWithKnownRequiredField } from "../shared/workflowFieldSupport.js";
import {
  callerActionIsConfirmationQuestion,
  callerActionRequestsStaffTransfer
} from "../shared/callerActionDecision.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { WorkflowStateView } from "../shared/workflowStateView.js";
import { ConfirmAppointmentStateView } from "./confirmAppointmentStateView.js";
import { ConfirmAppointmentToolAdapter } from "./confirmAppointmentToolAdapter.js";
import { createConfirmAppointmentTurnContext } from "./confirmAppointmentTurnContext.js";

const toolAdapter = new ConfirmAppointmentToolAdapter();

export const confirmAppointmentWorkflow: ConversationWorkflow = {
  name: "CONFIRM_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    return applyConfirmationExecutionBoundary(session, result);
  },
  applyToolResultPolicy(session: CallSession, toolName: string, toolResult: unknown): ToolPolicyDecision | undefined {
    const lookupDecision = applyConfirmationLookupBoundary(session, toolName, toolResult);
    if (lookupDecision) {
      return lookupDecision;
    }

    return applyConfirmationCompletionBoundary(session, toolName, toolResult);
  }
};

function applyConfirmationExecutionBoundary(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision | undefined {
  if (!isConfirmIntent(session.currentIntent)) {
    return undefined;
  }

  if (isTransferToStaff(result) && callerActionRequestsStaffTransfer(result)) {
    return undefined;
  }

  const context = createConfirmAppointmentTurnContext(session, result);
  const requiredFieldRetry = retryToolWithKnownRequiredField({
    session,
    result,
    stateView: new WorkflowStateView(session.workflowState),
    retryToolName: "GET_NEXT_APPOINTMENT"
  });
  if (requiredFieldRetry) {
    return requiredFieldRetry;
  }

  if (callerActionIsConfirmationQuestion(result)) {
    return {
      instruction: "The caller is asking about appointment confirmation, not authorizing a state-changing confirmation. Explain that you can help confirm an appointment, and ask which appointment they would like to confirm. Do not request CONFIRM_APPOINTMENT.",
      repromptContext: {
        type: context.selectionOptions.length > 0 ? "CHOOSE_CONFIRMABLE_APPOINTMENT" : "CONFIRM_SELECTED_APPOINTMENT",
        selectedAppointment: context.pendingSelection ? {
          appointmentId: context.pendingSelection.appointmentId,
          appointmentDate: context.pendingSelection.appointmentDate,
          doctorName: context.pendingSelection.doctorName
        } : undefined,
        options: context.selectionOptions.map((option) => ({
          appointmentId: option.appointmentId,
          appointmentDate: option.appointmentDate,
          doctorName: option.doctorName
        }))
      }
    };
  }

  if (shouldAnswerFromCompletedConfirmation(context)) {
    return {
      instruction: "The appointment confirmation workflow is already completed. Answer the caller using the completed backend state. Do not say you are confirming it now, and do not request another confirmation tool unless the caller clearly asks to confirm a different appointment.",
      repromptContext: {
        type: "CONFIRMATION_COMPLETED",
        selectedAppointment: {
          appointmentId: context.stateView.selectedAppointmentId()
        }
      }
    };
  }

  if (context.pendingConfirmationStatus === "READY_TO_EXECUTE") {
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {
            ...result.toolRequest?.arguments,
            appointmentId: session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId
          }
        }
      }
    };
  }

  if (context.pendingSelection) {
    return {
      instruction: "A confirmation execution boundary is active. Continue the confirmation workflow using the provided boundary context. Stay with appointment selection and confirmation unless the caller explicitly asks for staff or the backend requires handoff.",
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
      instruction: "A confirmation execution boundary is active. Continue the confirmation workflow using the provided boundary context. Help the caller choose one confirmable appointment before any state-changing tool request unless the caller explicitly asks for staff or the backend requires handoff.",
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

function isTransferToStaff(result: ModelTurnResult): boolean {
  return result.toolRequest?.name === "TRANSFER_TO_STAFF"
    || (typeof result.intent === "string" && result.intent.trim().toUpperCase() === "TRANSFER_TO_STAFF");
}

function applyConfirmationLookupBoundary(
  session: CallSession,
  toolName: string,
  toolResult: unknown
): ToolPolicyDecision | undefined {
  if (toolName !== "GET_NEXT_APPOINTMENT" || !isConfirmIntent(session.currentIntent) || !isSuccessfulToolResult(toolResult)) {
    return undefined;
  }

  const context = createConfirmAppointmentTurnContext(session, {});
  if (context.pendingConfirmationStatus === "READY_TO_EXECUTE") {
    return {
      overrideResult: {
        intent: "CONFIRM_APPOINTMENT",
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
      instruction: "A confirmation boundary is active for the selected appointment. Ask the caller only to confirm the selected appointment before any state-changing tool request.",
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
      instruction: "A confirmation boundary is active with multiple confirmable appointments. Ask the caller which appointment they want to confirm before any state-changing tool request.",
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

function applyConfirmationCompletionBoundary(
  session: CallSession,
  toolName: string,
  toolResult: unknown
): ToolPolicyDecision | undefined {
  if (toolName !== "CONFIRM_APPOINTMENT" || !isSuccessfulToolResult(toolResult)) {
    return undefined;
  }

  const stateView = new ConfirmAppointmentStateView(new WorkflowStateView(session.workflowState));
  if (!stateView.isCompleted()) {
    return undefined;
  }

  return {
    instruction: "The appointment confirmation has already completed successfully. Thank the caller or state the completed result using the backend workflow state. Do not say you are confirming it now, and do not ask for the same confirmation again.",
    repromptContext: {
      type: "CONFIRMATION_COMPLETED",
      selectedAppointment: {
        appointmentId: stateView.selectedAppointmentId()
      }
    }
  };
}

function shouldAnswerFromCompletedConfirmation(
  context: ReturnType<typeof createConfirmAppointmentTurnContext>
): boolean {
  if (!context.stateView.isCompleted()) {
    return false;
  }

  if (context.pendingConfirmationStatus || context.pendingSelection || context.selectionOptions.length > 0) {
    return false;
  }

  if (context.result.toolRequest && context.result.toolRequest.name !== "CONFIRM_APPOINTMENT") {
    return false;
  }

  return isConfirmIntent(context.result.intent)
    || context.result.toolRequest?.name === "CONFIRM_APPOINTMENT";
}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return !!toolResult
    && typeof toolResult === "object"
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}
