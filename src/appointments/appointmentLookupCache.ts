import { CallSession } from "../calls/callSession.js";

export function invalidateAppointmentLookupCacheAfterConfirmation(
  session: CallSession,
  toolName: string,
  toolResult: unknown
): void {
  if (toolName !== "CONFIRM_APPOINTMENT" || !isSuccessfulToolResult(toolResult)) {
    return;
  }

  delete session.lastToolResults.GET_NEXT_APPOINTMENT;
}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return typeof toolResult === "object"
    && toolResult !== null
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}
