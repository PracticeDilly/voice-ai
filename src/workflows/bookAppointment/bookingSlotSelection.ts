import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";

export function callerSelectedAvailableBookingSlot(session: CallSession, result: ModelTurnResult): boolean {
  if (session.workflowState?.workflow !== "BOOK_APPOINTMENT"
    || session.workflowState.state !== "SELECT_SLOT") {
    return false;
  }

  const requestedSlot = result.toolRequest?.arguments;
  const slots = session.workflowState.context?.slots;
  if (!requestedSlot || !Array.isArray(slots)
    || !slots.some((slot) => slot && typeof slot === "object"
      && (slot as { slotDate?: unknown; slotTime?: unknown }).slotDate === requestedSlot.slotDate
      && (slot as { slotDate?: unknown; slotTime?: unknown }).slotTime === requestedSlot.slotTime)) {
    return false;
  }

  const patientTurns = session.transcript.filter((turn) => turn.speaker === "patient");
  const callerText = patientTurns.at(-1)?.text.trim() ?? "";
  const bookingRequested = patientTurns.some((turn) =>
    /\b(?:book|schedule|make|set up)\b.{0,50}\bappointment\b/i.test(turn.text)
  );
  if (!bookingRequested || !callerText
    || /\?|\b(?:no|not|maybe|perhaps|might|unsure|not sure|what about|do you have)\b/i.test(callerText)) {
    return false;
  }

  const choiceIsAffirmative = /\b(?:good|fine|perfect|works?|take|choose|pick|book|reserve|go with|that one)\b/i.test(callerText)
    || /^\s*(?:the\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?[.!]?\s*$/i.test(callerText);
  if (!choiceIsAffirmative || typeof requestedSlot.slotTime !== "string") {
    return false;
  }

  const selectedTime = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(requestedSlot.slotTime.trim());
  if (!selectedTime) {
    return false;
  }
  const spokenTimes = [...callerText.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi)];
  const matchingSpokenTime = spokenTimes.find((time) =>
    Number(time[1]) === Number(selectedTime[1])
    && time[2] === selectedTime[2]
    && (!time[3] || time[3].toLowerCase() === selectedTime[3].toLowerCase())
  );
  if (!matchingSpokenTime) {
    return false;
  }

  const matchingOfferedSlots = slots.filter((slot) => {
    const time = slot && typeof slot === "object" && "slotTime" in slot
      ? (slot as { slotTime?: unknown }).slotTime
      : undefined;
    const parsed = typeof time === "string" ? /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(time.trim()) : null;
    return parsed && Number(parsed[1]) === Number(selectedTime[1])
      && parsed[2] === selectedTime[2]
      && (!matchingSpokenTime[3] || parsed[3].toLowerCase() === matchingSpokenTime[3].toLowerCase());
  });
  return matchingOfferedSlots.length === 1;
}
