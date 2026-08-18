import { ToolRequest, ToolResult } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";

const consentSources = new Set([
  "CALLER_EXPLICIT_REQUEST",
  "CALLER_ACCEPTED_FOLLOWUP_OFFER"
]);

export function syncPendingHandoffRequest(session: CallSession, tool: ToolRequest): void {
  if (tool.name !== "CREATE_HANDOFF_REQUEST" || !hasStructuredCallerConsent(tool)) {
    return;
  }

  session.pendingActions.CREATE_HANDOFF_REQUEST = {
    status: "READY_TO_EXECUTE",
    consentSource: tool.arguments.consentSource as "CALLER_EXPLICIT_REQUEST" | "CALLER_ACCEPTED_FOLLOWUP_OFFER",
    createdAt: new Date().toISOString()
  };
}

export function consumePendingHandoffRequest(
  session: CallSession,
  toolName: string,
  toolResult: ToolResult
): void {
  if (toolName === "CREATE_HANDOFF_REQUEST" && toolResult.ok === true) {
    delete session.pendingActions.CREATE_HANDOFF_REQUEST;
  }
}

export function pendingHandoffRequestError(session: CallSession, tool: ToolRequest): string | undefined {
  if (tool.name !== "CREATE_HANDOFF_REQUEST") {
    return undefined;
  }

  if (session.workflowState?.state === "HANDOFF_REQUIRED") {
    return undefined;
  }

  if (session.pendingActions.CREATE_HANDOFF_REQUEST?.status === "READY_TO_EXECUTE") {
    return undefined;
  }

  return "Staff follow-up requires caller consent or a backend-required handoff workflow.";
}

function hasStructuredCallerConsent(tool: ToolRequest): boolean {
  return tool.arguments?.callerConsent === true
    && typeof tool.arguments?.consentSource === "string"
    && consentSources.has(tool.arguments.consentSource);
}
