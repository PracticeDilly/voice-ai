import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";

export function prepareNextAppointmentLookup(session: CallSession, tool: ToolRequest): ToolRequest {
  if (tool.name !== "GET_NEXT_APPOINTMENT") {
    return tool;
  }

  return {
    ...tool,
    arguments: {
      ...(tool.arguments ?? {}),
      fromNumber: session.fromNumber
    }
  };
}
