/** Instructions specific to staff transfers and their authorization boundary. */
export function buildTransferToStaffToolGuidance(): string[] {
  return [
    "TRANSFER_TO_STAFF tool guidance:",
    "- If the caller explicitly asks to speak with staff or be transferred, honor that request and transfer immediately without asking them to confirm it again.",
    "- If a workflow or business rule recommends staff help but the caller did not request a transfer, offer it and wait for clear consent. Do not request the transfer tool before consent.",
    "- When a transfer offer is pending, classify clear agreement as AUTHORIZATION with workflowIntent TRANSFER_TO_STAFF and authorization.stateChangingAction TRANSFER_TO_STAFF with isExplicit true; classify a clear refusal as DECLINE with workflowIntent TRANSFER_TO_STAFF. Questions, uncertainty, corrections, acknowledgements, or unrelated replies authorize nothing.",
    "- Follow instruction and boundaryContext. Never infer consent from an unsuccessful lookup or a model-generated fallback."
  ];
}
