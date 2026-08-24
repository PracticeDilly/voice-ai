import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
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

    if (shouldAskCallerToSpellName(context)) {
      return {
        instruction: "The previous patient lookup did not find a match. Stay in the active next-appointment identity-recovery flow. Ask the caller to spell the name that may have been heard incorrectly before offering staff follow-up.",
        repromptContext: {
          type: "ASK_CALLER_TO_SPELL_NAME",
          identity: {
            firstName: meaningfulString(session.collectedFields.firstName),
            lastName: meaningfulString(session.collectedFields.lastName)
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

    const stateView = new NextAppointmentStateView(new WorkflowStateView(session.workflowState));
    if (shouldAskCallerToSpellAfterLookup(session, stateView)) {
      session.pendingActions.VERIFY_PATIENT_IDENTITY = {
        status: "NEEDS_NAME_SPELLING",
        createdAt: new Date().toISOString()
      };
      return {
        instruction: "The patient lookup did not find a match. Stay in the active appointment identity-verification flow. Ask the caller to spell the name that may have been heard incorrectly before offering staff follow-up.",
        repromptContext: {
          type: "ASK_CALLER_TO_SPELL_NAME",
          identity: {
            firstName: meaningfulString(session.collectedFields.firstName),
            lastName: meaningfulString(session.collectedFields.lastName)
          }
        }
      };
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

function shouldAskCallerToSpellName(context: ReturnType<typeof createNextAppointmentTurnContext>): boolean {
  return context.requestedHandoff
    && context.stateView.isPatientNotFound()
    && context.stateView.allowsLookup()
    && Object.keys(context.updatedIdentityFields).length === 0
    && hasKnownName(context.session.collectedFields)
    && !lastAssistantAskedToSpell(context.session);
}

function hasKnownName(fields: Record<string, unknown>): boolean {
  return !!meaningfulString(fields.firstName) || !!meaningfulString(fields.lastName);
}

function lastAssistantAskedToSpell(session: CallSession): boolean {
  for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
    const turn = session.transcript[index];
    if (turn.speaker !== "assistant") {
      continue;
    }

    return turn.text.toLowerCase().includes("spell");
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

function shouldAskCallerToSpellAfterLookup(session: CallSession, stateView: NextAppointmentStateView): boolean {
  return stateView.isPatientNotFound()
    && hasKnownName(session.collectedFields)
    && !lastAssistantAskedToSpell(session);
}

function hasNameUpdate(fields: Record<string, unknown>): boolean {
  return !!meaningfulString(fields.firstName) || !!meaningfulString(fields.lastName);
}

function clearIdentityVerification(session: CallSession): void {
  delete session.pendingActions.VERIFY_PATIENT_IDENTITY;
}

function isAppointmentIntent(intent: string | undefined): boolean {
  const normalized = typeof intent === "string" ? intent.trim().toUpperCase() : undefined;
  return normalized === "NEXT_APPOINTMENT" || normalized === "GET_NEXT_APPOINTMENT" || normalized === "CONFIRM_APPOINTMENT";
}
