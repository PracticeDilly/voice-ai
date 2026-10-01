import { ToolRequest, ToolResult } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { createBookAppointmentWorkflow } from "../bookAppointment/bookAppointmentWorkflow.js";
import { BookingAppointmentTypeResolutionPort } from "../bookAppointment/bookingAppointmentTypeResolver.js";
import { confirmAppointmentWorkflow } from "../confirmAppointment/confirmAppointmentWorkflow.js";
import { nextAppointmentWorkflow } from "../nextAppointment/nextAppointmentWorkflow.js";
import { patientVerificationWorkflow } from "./patientVerificationWorkflow.js";
import {
  ConversationWorkflow,
  ToolPolicyBoundaryContext,
  ToolPolicyDecision,
  WorkflowFollowupDecision,
  WorkflowErrorDecision,
  WorkflowToolResultContext
} from "./workflowTypes.js";

export class ConversationWorkflowRegistry {
  private readonly workflows: ConversationWorkflow[];

  constructor(appointmentTypeResolution?: BookingAppointmentTypeResolutionPort) {
    this.workflows = [
      patientVerificationWorkflow,
      createBookAppointmentWorkflow(appointmentTypeResolution),
      confirmAppointmentWorkflow,
      nextAppointmentWorkflow
    ];
  }

  applyWorkflowTurnPolicies(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    for (const workflow of this.workflows) {
      const decision = workflow.applyTurnPolicy?.(session, result);
      if (decision?.overrideResult || decision?.repromptContext || decision?.instruction) {
        return decision;
      }
    }
    return undefined;
  }

  limitToolChain(session: CallSession, result: ModelTurnResult, toolChainDepth: number): ModelTurnResult | undefined {
    if (!result.toolRequest) {
      return undefined;
    }
    const workflow = this.workflows.find((candidate) => candidate.toolAdapter?.supports(result.toolRequest!));
    return workflow?.limitToolChain?.(session, result, toolChainDepth);
  }

  prepareModelResult(session: CallSession, callerText: string, result: ModelTurnResult): ModelTurnResult {
    return this.workflows.reduce(
      (preparedResult, workflow) => workflow.prepareModelResult?.(session, callerText, preparedResult) ?? preparedResult,
      result
    );
  }

  prepareReply(session: CallSession, reply: string): string {
    return this.workflows.reduce(
      (preparedReply, workflow) => workflow.prepareReply?.(session, preparedReply) ?? preparedReply,
      reply
    );
  }

  startNewPatientBooking(session: CallSession): boolean {
    const workflow = this.workflows.find((candidate) => candidate.name === "BOOK_APPOINTMENT");
    if (!workflow?.startNewPatientBooking) {
      return false;
    }
    workflow.startNewPatientBooking(session);
    return true;
  }

  handleCallerTurn(session: CallSession, callerText: string) {
    for (const workflow of this.workflows) {
      const decision = workflow.handleCallerTurn?.(session, callerText);
      if (decision) {
        return decision;
      }
    }
    return undefined;
  }

  handleBookingEntry(session: CallSession, callerText: string, result: ModelTurnResult) {
    for (const workflow of this.workflows) {
      const decision = workflow.handleBookingEntry?.(session, callerText, result);
      if (decision) {
        return decision;
      }
    }
    return undefined;
  }

  constrainModelResult(session: CallSession, result: ModelTurnResult): void {
    for (const workflow of this.workflows) {
      workflow.modelLifecycle?.constrainResult?.(session, result);
    }
  }

  synchronizeModelData(session: CallSession, result: ModelTurnResult, callerText?: string): void {
    for (const workflow of this.workflows) {
      workflow.modelLifecycle?.synchronizeData?.(session, result, callerText);
    }
  }

  handleError(session: CallSession, error: unknown): WorkflowErrorDecision | undefined {
    for (const workflow of this.workflows) {
      const decision = workflow.handleError?.(session, error);
      if (decision) {
        return decision;
      }
    }
    return undefined;
  }

  applyWorkflowToolResultPolicies(
    session: CallSession,
    toolName: string,
    toolResult: unknown,
    request?: ModelTurnResult
  ): ToolPolicyDecision | undefined {
    for (const workflow of this.workflows) {
      const decision = workflow.applyToolResultPolicy?.(session, toolName, toolResult, request);
      if (decision?.overrideResult || decision?.repromptContext || decision?.instruction) {
        return decision;
      }
    }
    return undefined;
  }

  async prepareToolRequest(session: CallSession, result: ModelTurnResult): Promise<ModelTurnResult> {
    if (!result.toolRequest) {
      return result;
    }
    for (const workflow of this.workflows) {
      if (!workflow.toolAdapter?.supports(result.toolRequest)) {
        continue;
      }
      return workflow.prepareToolRequest
        ? workflow.prepareToolRequest(session, result)
        : result;
    }
    return result;
  }

  async prepareFollowup(
    session: CallSession,
    result: ModelTurnResult,
    followups: number,
    originatingToolName: string
  ): Promise<WorkflowFollowupDecision | undefined> {
    const workflow = this.workflows.find((candidate) => (
      candidate.name.toUpperCase() === originatingToolName.trim().toUpperCase()
    ));
    return workflow?.prepareFollowup
      ? workflow.prepareFollowup(session, result, followups)
      : undefined;
  }

  callerSelectedAvailableSlot(session: CallSession, result: ModelTurnResult): boolean {
    if (!result.toolRequest) {
      return false;
    }
    const workflow = this.workflows.find((candidate) => candidate.toolAdapter?.supports(result.toolRequest!));
    return workflow?.callerSelectedAvailableSlot?.(session, result) ?? false;
  }

  async resolveToolResult(
    session: CallSession,
    request: ModelTurnResult,
    toolResult: unknown,
    context: WorkflowToolResultContext
  ): Promise<ModelTurnResult | undefined> {
    const toolRequest = request.toolRequest;
    if (!toolRequest) {
      return undefined;
    }
    const workflow = this.workflows.find((candidate) => candidate.toolAdapter?.supports(toolRequest));
    return workflow?.resolveToolResult
      ? workflow.resolveToolResult(session, request, toolResult, context)
      : undefined;
  }

  synchronizeToolResult(
    session: CallSession,
    toolName: string,
    toolResult: ToolResult,
    activeIntent: string | undefined,
    request: ModelTurnResult,
    context: WorkflowToolResultContext
  ): WorkflowToolResultContext {
    let synchronizedContext = context;
    for (const workflow of this.workflows) {
      const updates = workflow.synchronizeToolResult?.(session, toolName, toolResult, activeIntent, request);
      if (updates) {
        synchronizedContext = { ...synchronizedContext, ...updates };
      }
    }
    return synchronizedContext;
  }

  consumeToolResult(session: CallSession, toolName: string, toolResult: ToolResult): void {
    for (const workflow of this.workflows) {
      workflow.consumeToolResult?.(session, toolName, toolResult);
    }
  }

  invalidateToolResultCache(session: CallSession, toolName: string, toolResult: ToolResult): void {
    for (const workflow of this.workflows) {
      workflow.invalidateToolResultCache?.(session, toolName, toolResult);
    }
  }

  synchronizeModelResult(session: CallSession, result: ModelTurnResult): void {
    for (const workflow of this.workflows) {
      workflow.modelLifecycle?.synchronizeResult?.(session, result);
    }
  }

  hydrateContext(session: CallSession): void {
    for (const workflow of this.workflows) {
      workflow.modelLifecycle?.hydrateContext?.(session);
    }
  }

  shouldContinuePolicyReprompt(session: CallSession, result: ModelTurnResult): boolean {
    return this.workflows.some((workflow) => workflow.modelLifecycle?.shouldContinuePolicyReprompt?.(session, result) === true);
  }

  async resolvePolicyReprompt(session: CallSession, context: ToolPolicyBoundaryContext): Promise<ModelTurnResult | undefined> {
    for (const workflow of this.workflows) {
      const result = await workflow.resolvePolicyReprompt?.(session, context);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  prepareWorkflowTool(session: CallSession, tool: ToolRequest): ToolRequest {
    return this.workflows.reduce((preparedTool, workflow) => {
      if (!workflow.toolAdapter?.supports(preparedTool)) {
        return preparedTool;
      }
      return workflow.toolAdapter.prepareTool(session, preparedTool);
    }, tool);
  }

  validateWorkflowTool(session: CallSession, tool: ToolRequest): string | undefined {
    for (const workflow of this.workflows) {
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
}

const defaultRegistry = new ConversationWorkflowRegistry();

export function applyWorkflowTurnPolicies(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
  return defaultRegistry.applyWorkflowTurnPolicies(session, result);
}

export function applyWorkflowToolResultPolicies(
  session: CallSession,
  toolName: string,
  toolResult: unknown,
  request?: ModelTurnResult
): ToolPolicyDecision | undefined {
  return defaultRegistry.applyWorkflowToolResultPolicies(session, toolName, toolResult, request);
}

export function prepareWorkflowTool(session: CallSession, tool: ToolRequest): ToolRequest {
  return defaultRegistry.prepareWorkflowTool(session, tool);
}

export function validateWorkflowTool(session: CallSession, tool: ToolRequest): string | undefined {
  return defaultRegistry.validateWorkflowTool(session, tool);
}
