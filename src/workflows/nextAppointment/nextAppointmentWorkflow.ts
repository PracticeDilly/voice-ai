import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { createNextAppointmentTurnContext } from "./nextAppointmentTurnContext.js";
import { NextAppointmentToolAdapter } from "./nextAppointmentToolAdapter.js";

const toolAdapter = new NextAppointmentToolAdapter();

export const nextAppointmentWorkflow: ConversationWorkflow = {
  name: "NEXT_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    const context = createNextAppointmentTurnContext(session, result);

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
    && context.stateView.isPatientNotFound()
    && context.stateView.allowsLookup()
    && Object.keys(context.updatedIdentityFields).length > 0;
}
