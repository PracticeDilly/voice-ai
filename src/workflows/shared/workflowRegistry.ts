import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { confirmAppointmentWorkflow } from "../confirmAppointment/confirmAppointmentWorkflow.js";
import { nextAppointmentWorkflow } from "../nextAppointment/nextAppointmentWorkflow.js";
import { ConversationWorkflow, ToolPolicyDecision } from "./workflowTypes.js";

const workflows: ConversationWorkflow[] = [
  confirmAppointmentWorkflow,
  nextAppointmentWorkflow
];

export function applyWorkflowTurnPolicies(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision | undefined {
  for (const workflow of workflows) {
    const decision = workflow.applyTurnPolicy?.(session, result);
    if (decision?.overrideResult || decision?.repromptContext || decision?.instruction) {
      return decision;
    }
  }

  return undefined;
}

export function applyWorkflowToolResultPolicies(
  session: CallSession,
  toolName: string,
  toolResult: unknown
): ToolPolicyDecision | undefined {
  for (const workflow of workflows) {
    const decision = workflow.applyToolResultPolicy?.(session, toolName, toolResult);
    if (decision?.overrideResult || decision?.repromptContext || decision?.instruction) {
      return decision;
    }
  }

  return undefined;
}

export function prepareWorkflowTool(session: CallSession, tool: ToolRequest): ToolRequest {
  return workflows.reduce((preparedTool, workflow) => {
    if (!workflow.toolAdapter?.supports(preparedTool)) {
      return preparedTool;
    }

    return workflow.toolAdapter.prepareTool(session, preparedTool);
  }, tool);
}

export function validateWorkflowTool(session: CallSession, tool: ToolRequest): string | undefined {
  for (const workflow of workflows) {
    if (!workflow.toolAdapter?.supports(tool)) {
      continue;
    }

    const error = workflow.toolAdapter.validateTool?.(session, tool);
    if (error) {
      return error;
    }
  }

  return undefined;
}
