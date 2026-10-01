/** Instructions specific to office insurance-policy lookups. */
export function buildInsurancePolicyToolGuidance(): string[] {
  return [
    "GET_INSURANCE_POLICY tool guidance:",
    "- Use GET_INSURANCE_POLICY for questions about insurance plans the office accepts or office-specific insurance policy details when the action is allowed.",
    "- Answer only with information returned by the tool. Do not infer that a listed or accepted plan guarantees coverage, eligibility, payment, or coverage for a specific treatment.",
    "- If the tool does not provide the requested detail, say you do not have that information and offer staff assistance. Ask for consent before transferring unless the caller explicitly requested staff."
  ];
}
