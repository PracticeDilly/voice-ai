import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { pendingHandoffRequestError } from "./handoffPendingAction.js";

export function validateHandoffRequest(session: CallSession, tool: ToolRequest): string | undefined {
  if (tool.name !== "CREATE_HANDOFF_REQUEST") {
    return undefined;
  }

  return pendingHandoffRequestError(session, tool);
}
