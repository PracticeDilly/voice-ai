import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession, PendingPatientWorkflowAction } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import {
  callerActionExplicitlyAuthorizesNewPatient,
  callerActionRequestsStaffTransfer
} from "./callerActionDecision.js";
import { ConversationWorkflow, ToolPolicyDecision, WorkflowToolAdapter } from "./workflowTypes.js";
import { newPatientConfirmationFields } from "../bookAppointment/newPatientDataConfirmation.js";

const patientSpecificTools = new Set([
  "GET_NEXT_APPOINTMENT",
  "BOOK_APPOINTMENT",
  "CONFIRM_APPOINTMENT"
]);

const verificationToolName = "VERIFY_PATIENT";
const maxIdentityVerificationAttempts = 2;

const patientVerificationToolAdapter: WorkflowToolAdapter = {
  supports(tool: ToolRequest): boolean {
    return tool.name === verificationToolName;
  },

  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest {
    return {
      ...tool,
      arguments: {
        ...(textValue(tool.arguments?.firstName ?? session.collectedFields.firstName)
          ? { firstName: textValue(tool.arguments?.firstName ?? session.collectedFields.firstName) } : {}),
        ...(textValue(tool.arguments?.dob ?? session.collectedFields.dob)
          ? { dob: textValue(tool.arguments?.dob ?? session.collectedFields.dob) } : {}),
        ...(textValue(session.fromNumber) ? { fromNumber: textValue(session.fromNumber) } : {}),
        ...(tool.arguments?.continueAsNewPatient === true ? { continueAsNewPatient: true } : {})
      }
    };
  }
};

export const patientVerificationWorkflow: ConversationWorkflow = {
  name: "PATIENT_VERIFICATION",
  toolAdapter: patientVerificationToolAdapter,

  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    if (isBookingIntent(session.currentIntent)
      && callerActionExplicitlyAuthorizesNewPatient(result)
      && isNewPatientBookingTransitionState(session)) {
      return continueAsNewPatientBooking(session, result);
    }

    const correctionRetry = retryIdentityCorrection(session, result);
    if (correctionRetry) {
      return correctionRetry;
    }

    const requestedTool = result.toolRequest;
    if (!requestedTool) {
      if (isUnauthorizedTransfer(session, result)) {
        return transferConfirmationDecision(session);
      }
      return undefined;
    }

    if (requestedTool.name === "TRANSFER_TO_STAFF" && isUnauthorizedTransfer(session, result)) {
      return transferConfirmationDecision(session);
    }

    if (requestedTool.name === verificationToolName) {
      const missingRequiredFieldPrompt = verificationRequiredFieldPrompt(session, result);
      if (missingRequiredFieldPrompt) {
        return {
          overrideResult: {
            ...result,
            intent: session.currentIntent ?? result.intent,
            reply: missingRequiredFieldPrompt,
            callerAction: undefined,
            toolRequest: undefined,
            shouldEndCall: false
          },
          instruction: "Do not call VERIFY_PATIENT again until the caller supplies the required identity field. Ask only for that field and preserve the pending appointment workflow."
        };
      }
      if (isNewPatientConfirmationState(session)
        && isBookingIntent(session.currentIntent)
        && !callerActionExplicitlyAuthorizesNewPatient(result)) {
        return newPatientConfirmationDecision();
      }
      if (verificationCapabilityEnabled(session)
        && !isPatientVerified(session)
        && !session.pendingPatientWorkflow) {
        const pending = inferPendingPatientWorkflow(session, result);
        if (pending) {
          session.pendingPatientWorkflow = pendingAction(pending);
        }
      }
      if (callerActionExplicitlyAuthorizesNewPatient(result) && isBookingIntent(session.currentIntent)) {
        requestedTool.arguments = {
          ...requestedTool.arguments,
          continueAsNewPatient: true
        };
      }
      return undefined;
    }

    if (!patientSpecificTools.has(requestedTool.name)
      || !verificationCapabilityEnabled(session)
      || isPatientVerified(session)) {
      return undefined;
    }

    if (requestedTool.name === "BOOK_APPOINTMENT" && isNewPatientBookingCandidate(session)) {
      return undefined;
    }

    if (requestedTool.name === "BOOK_APPOINTMENT" && isNewPatientConfirmationState(session)) {
      session.pendingPatientWorkflow = pendingAction(requestedTool);
      return newPatientConfirmationDecision();
    }

    session.pendingPatientWorkflow = pendingAction(requestedTool);
    return {
      overrideResult: {
        ...result,
        toolRequest: {
          name: verificationToolName,
          arguments: identityArguments(session, result)
        }
      }
    };
  },

  applyToolResultPolicy(session: CallSession, toolName: string, toolResult: unknown): ToolPolicyDecision | undefined {
    if (toolName === "BOOK_APPOINTMENT" && isCompletedBookingResult(toolResult)) {
      session.newPatientBookingCandidate = false;
      delete session.newPatientDataConfirmation;
      return undefined;
    }

    if (toolName !== verificationToolName) {
      return undefined;
    }

    if (!isSuccessfulToolResult(toolResult)) {
      delete session.verifiedIdentityFingerprint;
      rememberIdentityCorrection(session);
      return identityCorrectionPrompt(session);
    }

    if (isNewPatientCandidateState(session) && session.pendingPatientWorkflow?.name === "BOOK_APPOINTMENT") {
      session.newPatientBookingCandidate = true;
      const pending = session.pendingPatientWorkflow;
      delete session.pendingPatientWorkflow;
      return {
        overrideResult: {
          intent: pending.name,
          toolRequest: {
            name: pending.name,
            arguments: {
              ...pending.arguments,
              continueAsNewPatient: true
            }
          }
        }
      };
    }

    if (!isVerifiedWorkflowState(session)) {
      delete session.verifiedIdentityFingerprint;
      rememberIdentityCorrection(session);
      const correctionPrompt = identityCorrectionPrompt(session);
      if (correctionPrompt) {
        return correctionPrompt;
      }
      return undefined;
    }

    session.newPatientBookingCandidate = false;
    delete session.newPatientDataConfirmation;
    session.verifiedIdentityFingerprint = identityFingerprint(session);

    const pending = session.pendingPatientWorkflow;
    if (!pending) {
      return undefined;
    }

    delete session.pendingPatientWorkflow;
    return {
      overrideResult: {
        intent: pending.name,
        toolRequest: {
          name: pending.name,
          arguments: pending.arguments
        }
      }
    };
  }
};

function verificationRequiredFieldPrompt(session: CallSession, result: ModelTurnResult): string | undefined {
  if (session.workflowState?.workflow !== "PATIENT_VERIFICATION"
    || session.workflowState.state !== "NEEDS_INPUT") {
    return undefined;
  }

  const requiredField = session.workflowState.requiredField;
  if (!requiredField || hasCapturedRequiredField(session, result, requiredField)) {
    return undefined;
  }

  if (requiredField === "firstName") {
    return "To check your appointment, may I have your first name, please?";
  }
  if (requiredField === "dob") {
    return "To check your appointment, may I have your date of birth, please?";
  }
  return `To continue, may I have your ${requiredField}, please?`;
}

function hasCapturedRequiredField(
  session: CallSession,
  result: ModelTurnResult,
  requiredField: string
): boolean {
  const sources = [
    result.collectedFields,
    result.toolRequest?.arguments,
    session.collectedFields
  ];

  return sources.some((source) => textValue(source?.[requiredField]));
}

function identityCorrectionPrompt(session: CallSession): ToolPolicyDecision | undefined {
  if (!["FIRST_NAME_NO_MATCH", "DOB_NO_MATCH"].includes(session.workflowState?.failureReason ?? "")) {
    return undefined;
  }

  const status = session.pendingActions.VERIFY_PATIENT_IDENTITY?.status;
  if (!status) {
    return undefined;
  }

  const isNameCorrection = status === "NEEDS_NAME_SPELLING";
  return {
    overrideResult: {
      intent: session.currentIntent,
      reply: isNameCorrection
        ? "I couldn't match that first name to the record linked to this phone number. Could you please spell your first name?"
        : "I couldn't match that date of birth to the record linked to this phone number. Could you please repeat your date of birth?",
      callerAction: undefined,
      toolRequest: undefined,
      shouldEndCall: false
    },
    instruction: isNameCorrection
      ? "Ask the caller to spell the first name before attempting another verification. Do not continue as a new patient unless the caller explicitly authorizes that choice."
      : "Ask the caller to correct the date of birth before attempting another verification. Do not ask for unrelated identity details."
  };
}

function pendingAction(tool: ToolRequest): PendingPatientWorkflowAction {
  return {
    name: tool.name as PendingPatientWorkflowAction["name"],
    arguments: { ...tool.arguments },
    createdAt: new Date().toISOString()
  };
}

function inferPendingPatientWorkflow(session: CallSession, result: ModelTurnResult): ToolRequest | undefined {
  const intent = normalizedIntent(session.currentIntent);
  if (intent === "NEXT_APPOINTMENT" || intent === "GET_NEXT_APPOINTMENT") {
    return {
      name: "GET_NEXT_APPOINTMENT",
      arguments: identityArguments(session, result)
    };
  }

  if (intent === "BOOK_APPOINTMENT") {
    return {
      name: "BOOK_APPOINTMENT",
      arguments: {
        ...session.collectedFields,
        ...(result.collectedFields ?? {}),
        ...(textValue(session.fromNumber) ? { fromNumber: textValue(session.fromNumber) } : {})
      }
    };
  }

  if (intent === "CONFIRM_APPOINTMENT") {
    return {
      name: "CONFIRM_APPOINTMENT",
      arguments: {
        ...session.collectedFields,
        ...(result.collectedFields ?? {}),
        ...(result.toolRequest?.arguments ?? {})
      }
    };
  }

  return undefined;
}

function identityArguments(session: CallSession, result: ModelTurnResult): Record<string, unknown> {
  const fields = {
    ...session.collectedFields,
    ...(result.collectedFields ?? {}),
    ...(result.toolRequest?.arguments ?? {})
  };
  return {
    ...(textValue(fields.firstName) ? { firstName: textValue(fields.firstName) } : {}),
    ...(textValue(fields.dob) ? { dob: textValue(fields.dob) } : {}),
    ...(textValue(session.fromNumber) ? { fromNumber: textValue(session.fromNumber) } : {})
  };
}

function retryIdentityCorrection(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
  const pendingCorrection = session.pendingActions.VERIFY_PATIENT_IDENTITY;
  if (!pendingCorrection || callerActionRequestsStaffTransfer(result)) {
    return undefined;
  }

  const correctedField = pendingCorrection.status === "NEEDS_NAME_SPELLING" ? "firstName" : "dob";
  const correctedValue = textValue(result.collectedFields?.[correctedField]);
  const attempts = pendingCorrection.attempts ?? 1;

  if (attempts >= maxIdentityVerificationAttempts
    || (correctedValue && sameIdentityValue(correctedValue, pendingCorrection.value))) {
    return identityCorrectionLimitDecision(session, result);
  }

  if (correctedValue && !sameIdentityValue(correctedValue, pendingCorrection.value)) {
    return {
      overrideResult: {
        ...result,
        intent: session.currentIntent ?? result.intent,
        toolRequest: {
          name: verificationToolName,
          arguments: identityArguments(session, result)
        }
      },
      instruction: "Retry patient verification using the corrected identity value supplied by the caller."
    };
  }

  return {
    overrideResult: {
      ...result,
      intent: session.currentIntent ?? result.intent,
      reply: pendingCorrection.status === "NEEDS_NAME_SPELLING"
        ? "I couldn't match that first name to the record linked to this phone number. Could you please spell your first name?"
        : "I couldn't match that date of birth to the record linked to this phone number. Could you please repeat your date of birth?",
      callerAction: undefined,
      toolRequest: undefined,
      shouldEndCall: false
    },
    instruction: "Do not retry verification with the same identity value. Ask only for the requested correction and wait for the caller's corrected value."
  };
}

function identityCorrectionLimitDecision(session: CallSession, result: ModelTurnResult): ToolPolicyDecision {
  delete session.pendingActions.VERIFY_PATIENT_IDENTITY;
  return {
    overrideResult: {
      ...result,
      intent: session.currentIntent ?? result.intent,
      reply: "I still couldn't match those details to a patient record. Would you like to continue as a new patient or speak with office staff?",
      callerAction: undefined,
      toolRequest: undefined,
      shouldEndCall: false
    },
    instruction: "Do not ask for the same date of birth or first name again. For a booking, wait for explicit authorization to continue as a new patient or an explicit request to speak with office staff."
  };
}

function rememberIdentityCorrection(session: CallSession): void {
  const reason = session.workflowState?.failureReason;
  if (reason === "FIRST_NAME_NO_MATCH") {
    const previous = session.pendingActions.VERIFY_PATIENT_IDENTITY;
    session.pendingActions.VERIFY_PATIENT_IDENTITY = {
      status: "NEEDS_NAME_SPELLING",
      value: textValue(session.collectedFields.firstName),
      attempts: previous?.status === "NEEDS_NAME_SPELLING" ? (previous.attempts ?? 0) + 1 : 1,
      createdAt: new Date().toISOString()
    };
  } else if (reason === "DOB_NO_MATCH") {
    const previous = session.pendingActions.VERIFY_PATIENT_IDENTITY;
    session.pendingActions.VERIFY_PATIENT_IDENTITY = {
      status: "NEEDS_DOB_CORRECTION",
      value: textValue(session.collectedFields.dob),
      attempts: previous?.status === "NEEDS_DOB_CORRECTION" ? (previous.attempts ?? 0) + 1 : 1,
      createdAt: new Date().toISOString()
    };
  }
}

function ensurePendingBooking(session: CallSession, result: ModelTurnResult): void {
  if (!session.pendingPatientWorkflow) {
    const pending = inferPendingPatientWorkflow(session, result);
    if (pending) {
      session.pendingPatientWorkflow = pendingAction(pending);
    }
  }
}

function continueAsNewPatientBooking(session: CallSession, result: ModelTurnResult): ToolPolicyDecision {
  session.collectedFields = {
    ...session.collectedFields,
    ...(result.collectedFields ?? {}),
    continueAsNewPatient: true
  };
  delete session.pendingActions.VERIFY_PATIENT_IDENTITY;
  session.newPatientBookingCandidate = true;
  session.newPatientDataConfirmation = { confirmed: {} };
  session.workflowState = {
    contractVersion: session.workflowState?.contractVersion ?? 1,
    workflow: "BOOK_APPOINTMENT",
    state: "NEEDS_NEW_PATIENT_DATA",
    requiredField: newPatientConfirmationFields.find((field) => (
      !textValue(session.collectedFields[field])
      && !(field === "patientPhone" && textValue(session.fromNumber))
    )) ?? null,
    allowedActions: ["BOOK_APPOINTMENT"],
    context: {
      ...(session.workflowState?.context ?? {}),
      patientType: "NEW_PATIENT",
      patientVerified: false,
      canDisclosePatientData: false
    },
    failureReason: null
  };
  ensurePendingBooking(session, result);

  return {
    overrideResult: {
      ...result,
      intent: "BOOK_APPOINTMENT",
      toolRequest: undefined,
      shouldEndCall: false
    }
  };
}

function isNewPatientConfirmationState(session: CallSession): boolean {
  return session.workflowState?.workflow === "PATIENT_VERIFICATION"
    && session.workflowState.state === "NEEDS_NEW_PATIENT_CONFIRMATION";
}

function isNewPatientBookingTransitionState(session: CallSession): boolean {
  if (session.workflowState?.workflow !== "PATIENT_VERIFICATION") {
    return false;
  }

  if (isNewPatientConfirmationState(session)) {
    return true;
  }

  return session.workflowState.state === "FAILED"
    && ["NO_EXISTING_PATIENT_RECORD", "PHONE_NO_MATCH", "FIRST_NAME_NO_MATCH", "DOB_NO_MATCH"]
      .includes(session.workflowState.failureReason ?? "");
}

function isUnauthorizedTransfer(session: CallSession, result: ModelTurnResult): boolean {
  return isPatientVerificationBoundary(session)
    && isTransferResult(result)
    && !callerActionRequestsStaffTransfer(result);
}

function isPatientVerificationBoundary(session: CallSession): boolean {
  return session.workflowState?.workflow === "PATIENT_VERIFICATION"
    && ["NEEDS_NEW_PATIENT_CONFIRMATION", "FAILED", "HANDOFF_REQUIRED"].includes(session.workflowState.state);
}

function isTransferResult(result: ModelTurnResult): boolean {
  return result.toolRequest?.name === "TRANSFER_TO_STAFF"
    || normalizedIntent(result.intent) === "TRANSFER_TO_STAFF";
}

function transferConfirmationDecision(session: CallSession): ToolPolicyDecision {
  return {
    instruction: isNewPatientConfirmationState(session) && isBookingIntent(session.currentIntent)
      ? "Do not transfer yet. Tell the caller that no existing patient record was found and ask whether they want to continue as a new patient or speak with office staff. Do not collect new-patient fields until they explicitly choose the new-patient option."
      : "Do not transfer yet. Explain the verification issue and ask whether the caller would like to speak with office staff. Transfer only after an explicit yes or direct request.",
    repromptContext: {
      type: isNewPatientConfirmationState(session) && isBookingIntent(session.currentIntent)
        ? "NEW_PATIENT_CONFIRMATION"
        : "IDENTITY_CORRECTION"
    }
  };
}

function newPatientConfirmationDecision(): ToolPolicyDecision {
  return {
    instruction: "Ask the caller for explicit permission before continuing as a new patient. Do not call BOOK_APPOINTMENT or collect new-patient details yet.",
    repromptContext: { type: "NEW_PATIENT_CONFIRMATION" }
  };
}

function isBookingIntent(intent: string | undefined): boolean {
  return normalizedIntent(intent) === "BOOK_APPOINTMENT";
}

function isPatientVerified(session: CallSession): boolean {
  return isVerifiedWorkflowState(session)
    && session.verifiedIdentityFingerprint === identityFingerprint(session);
}

function isNewPatientBookingCandidate(session: CallSession): boolean {
  return session.newPatientBookingCandidate === true
    && normalizedIntent(session.currentIntent) === "BOOK_APPOINTMENT";
}

function isNewPatientCandidateState(session: CallSession): boolean {
  return session.workflowState?.state === "NEW_PATIENT_CANDIDATE"
    && session.workflowState.context?.patientType === "NEW_PATIENT";
}

function isVerifiedWorkflowState(session: CallSession): boolean {
  return session.workflowState?.context?.patientVerified === true
    && session.workflowState.context.canDisclosePatientData === true;
}

function verificationCapabilityEnabled(session: CallSession): boolean {
  return session.officeContext?.allowedActions?.includes(verificationToolName) === true;
}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return typeof toolResult === "object"
    && toolResult !== null
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}

function isCompletedBookingResult(toolResult: unknown): boolean {
  if (!toolResult || typeof toolResult !== "object") {
    return false;
  }

  const workflowState = (toolResult as { workflowState?: unknown }).workflowState;
  return typeof workflowState === "object"
    && workflowState !== null
    && (workflowState as { state?: unknown }).state === "COMPLETED";
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sameIdentityValue(left: string, right: string | undefined): boolean {
  return right !== undefined && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function normalizedIntent(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().toUpperCase();
}

function identityFingerprint(session: CallSession): string {
  return JSON.stringify({
    fromNumber: textValue(session.fromNumber) ?? "",
    firstName: textValue(session.collectedFields.firstName) ?? "",
    dob: textValue(session.collectedFields.dob) ?? ""
  });
}
