/** Instructions specific to staff transfers and their authorization boundary. */
export function buildTransferToStaffToolGuidance(): string[] {
  return [
    "TRANSFER_TO_STAFF tool guidance:",
    "- If the caller explicitly asks to speak with staff or be transferred, honor that request and transfer immediately without asking them to confirm it again.",
    "- If a workflow recommends staff but the caller did not request transfer, offer it, set assistantAction to OFFER_STAFF_TRANSFER, and wait for clear consent. Do not request the transfer tool before consent.",
    "- If a transfer offer is pending, clear agreement or willingness to speak with the office now (e.g. 'I'll talk to the office') is AUTHORIZATION for TRANSFER_TO_STAFF; set isExplicit true and transfer immediately without asking them to confirm it again.",
    "- A direct request to speak with staff is REQUEST/TRANSFER_TO_STAFF and transfers now. Saying they will call later is not consent to transfer now.",
    "- A clear refusal is DECLINE; questions or unclear replies are not consent.",
    "- Follow instruction and boundaryContext. Never infer consent from an unsuccessful lookup or a model-generated fallback."
  ];
}
