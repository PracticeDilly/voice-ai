import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { retryToolWithKnownRequiredField } from "../shared/workflowFieldSupport.js";
import { WorkflowStateView } from "../shared/workflowStateView.js";
import { createNextAppointmentTurnContext } from "./nextAppointmentTurnContext.js";
import { NextAppointmentStateView } from "./nextAppointmentStateView.js";
import { NextAppointmentToolAdapter } from "./nextAppointmentToolAdapter.js";

const toolAdapter = new NextAppointmentToolAdapter();

export const nextAppointmentWorkflow: ConversationWorkflow = {
  name: "NEXT_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    const context = createNextAppointmentTurnContext(session, result);

    const requiredFieldRetry = retryToolWithKnownRequiredField({
      session,
      result,
      stateView: new WorkflowStateView(session.workflowState),
      retryToolName: "GET_NEXT_APPOINTMENT",
      extraArguments: context.updatedIdentityFields
    });
    if (requiredFieldRetry) {
      return requiredFieldRetry;
    }

    if (shouldContinueIdentityVerification(context)) {
      return {
        overrideResult: {
          ...result,
          toolRequest: {
            name: "GET_NEXT_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              ...context.updatedIdentityFields
            }
          }
        }
      };
    }

    if (shouldRefreshLookup(context)) {
      return {
        overrideResult: {
          ...result,
          toolRequest: {
            name: "GET_NEXT_APPOINTMENT",
            arguments: {
              ...session.collectedFields
            }
          }
        }
      };
    }

    if (shouldRetryLookupInsteadOfHandoff(context)) {
      return {
        overrideResult: {
          ...result,
          toolRequest: {
            name: "GET_NEXT_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              ...context.updatedIdentityFields
            }
          }
        }
      };
    }

    return undefined;
  },
  applyToolResultPolicy(session: CallSession, toolName: string): ToolPolicyDecision | undefined {
    if (toolName !== "GET_NEXT_APPOINTMENT" || !isAppointmentIntent(session.currentIntent)) {
      clearIdentityVerification(session);
      return undefined;
    }

    clearIdentityVerification(session);
    return undefined;
  }
};

function shouldRefreshLookup(context: ReturnType<typeof createNextAppointmentTurnContext>): boolean {
  return context.requestedLookup
    && context.result.toolRequest?.name !== "GET_NEXT_APPOINTMENT"
    && context.hasSuccessfulConfirmation
    && !context.hasFreshLookup;
}

function shouldRetryLookupInsteadOfHandoff(context: ReturnType<typeof createNextAppointmentTurnContext>): boolean {
  return context.requestedHandoff
    && !context.callerRequestedStaffTransfer
    && context.stateView.isPatientNotFound()
    && context.stateView.allowsLookup()
    && Object.keys(context.updatedIdentityFields).length > 0;
}

function shouldContinueIdentityVerification(context: ReturnType<typeof createNextAppointmentTurnContext>): boolean {
  if (context.result.toolRequest?.name === "GET_NEXT_APPOINTMENT") {
    return false;
  }

  const pendingStatus = context.session.pendingActions.VERIFY_PATIENT_IDENTITY?.status;
  if (!pendingStatus) {
    return false;
  }

  if (pendingStatus === "NEEDS_NAME_SPELLING") {
    return hasNameUpdate(context.updatedIdentityFields);
  }

  return false;
}

function meaningfulString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasNameUpdate(fields: Record<string, unknown>): boolean {
  return !!meaningfulString(fields.firstName)
    || !!meaningfulString(fields.dob)
    || !!meaningfulString(fields.dateOfBirth);
}

function clearIdentityVerification(session: CallSession): void {
  delete session.pendingActions.VERIFY_PATIENT_IDENTITY;
}

function isAppointmentIntent(intent: string | undefined): boolean {
  const normalized = typeof intent === "string" ? intent.trim().toUpperCase() : undefined;
  return normalized === "NEXT_APPOINTMENT" || normalized === "GET_NEXT_APPOINTMENT" || normalized === "CONFIRM_APPOINTMENT";
}
