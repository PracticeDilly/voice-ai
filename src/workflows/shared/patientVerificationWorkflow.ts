import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession, PendingPatientWorkflowAction } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { ConversationWorkflow, ToolPolicyDecision, WorkflowToolAdapter } from "./workflowTypes.js";

const patientSpecificTools = new Set([
  "GET_NEXT_APPOINTMENT",
  "BOOK_APPOINTMENT",
  "CONFIRM_APPOINTMENT"
]);

const verificationToolName = "VERIFY_PATIENT";

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
        ...(textValue(tool.arguments?.dob ?? session.collectedFields.dob ?? session.collectedFields.dateOfBirth)
          ? { dob: textValue(tool.arguments?.dob ?? session.collectedFields.dob ?? session.collectedFields.dateOfBirth) } : {}),
        ...(textValue(session.fromNumber) ? { fromNumber: textValue(session.fromNumber) } : {})
      }
    };
  }
};

export const patientVerificationWorkflow: ConversationWorkflow = {
  name: "PATIENT_VERIFICATION",
  toolAdapter: patientVerificationToolAdapter,

  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    const requestedTool = result.toolRequest;
    if (!requestedTool || requestedTool.name === verificationToolName) {
      return undefined;
    }

    if (!patientSpecificTools.has(requestedTool.name)
      || !verificationCapabilityEnabled(session)
      || isPatientVerified(session)) {
      return undefined;
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
    if (toolName !== verificationToolName) {
      return undefined;
    }

    if (!isSuccessfulToolResult(toolResult) || !isVerifiedWorkflowState(session)) {
      delete session.verifiedIdentityFingerprint;
      return undefined;
    }

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

function pendingAction(tool: ToolRequest): PendingPatientWorkflowAction {
  return {
    name: tool.name as PendingPatientWorkflowAction["name"],
    arguments: { ...tool.arguments },
    createdAt: new Date().toISOString()
  };
}

function identityArguments(session: CallSession, result: ModelTurnResult): Record<string, unknown> {
  const fields = {
    ...session.collectedFields,
    ...(result.collectedFields ?? {}),
    ...(result.toolRequest?.arguments ?? {})
  };
  return {
    ...(textValue(fields.firstName) ? { firstName: textValue(fields.firstName) } : {}),
    ...(textValue(fields.dob ?? fields.dateOfBirth) ? { dob: textValue(fields.dob ?? fields.dateOfBirth) } : {}),
    ...(textValue(session.fromNumber) ? { fromNumber: textValue(session.fromNumber) } : {})
  };
}

function isPatientVerified(session: CallSession): boolean {
  return isVerifiedWorkflowState(session)
    && session.verifiedIdentityFingerprint === identityFingerprint(session);
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

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function identityFingerprint(session: CallSession): string {
  return JSON.stringify({
    fromNumber: textValue(session.fromNumber) ?? "",
    firstName: textValue(session.collectedFields.firstName) ?? "",
    dob: textValue(session.collectedFields.dob ?? session.collectedFields.dateOfBirth) ?? ""
  });
}
