import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { WorkflowStateView } from "./workflowStateView.js";
import { ToolPolicyDecision } from "./workflowTypes.js";

export function retryToolWithKnownRequiredField(input: {
  session: CallSession;
  result: ModelTurnResult;
  stateView: WorkflowStateView;
  retryToolName: string;
  extraArguments?: Record<string, unknown>;
}): ToolPolicyDecision | undefined {
  const { session, result, stateView, retryToolName, extraArguments } = input;
  if (result.toolRequest?.name === retryToolName) {
    return undefined;
  }

  if (stateView.state() !== "NEEDS_INPUT") {
    return undefined;
  }

  if (!stateView.allowsAction(retryToolName)) {
    return undefined;
  }

  const requiredField = stateView.requiredField();
  if (!requiredField || !hasMeaningfulCollectedField(session.collectedFields, requiredField)) {
    return undefined;
  }

  return {
    overrideResult: {
      ...result,
      toolRequest: {
        name: retryToolName,
        arguments: {
          ...session.collectedFields,
          ...extraArguments
        }
      }
    }
  };
}

export function hasMeaningfulCollectedField(
  fields: Record<string, unknown>,
  fieldName: string
): boolean {
  if (fieldName === "dob") {
    return !!meaningfulString(fields.dob) || !!meaningfulString(fields.dateOfBirth);
  }

  return !!meaningfulString(fields[fieldName]);
}

export function meaningfulString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
