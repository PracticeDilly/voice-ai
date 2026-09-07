import { OfficeProviderContext } from "../../calls/callSession.js";

export function officeProviderNames(providers: OfficeProviderContext[] | undefined): string[] {
  if (!Array.isArray(providers)) {
    return [];
  }

  return providers
    .map((provider) => providerName(provider))
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

export function providerNameMatchesOfficeContext(
  providerName: unknown,
  providers: OfficeProviderContext[] | undefined
): boolean {
  const normalizedProviderName = normalizeProviderText(providerName);
  if (!normalizedProviderName) {
    return false;
  }

  return officeProviderNames(providers)
    .some((name) => normalizeProviderText(name) === normalizedProviderName);
}

export function singleOfficeContextProviderName(providers: OfficeProviderContext[] | undefined): string | undefined {
  const names = officeProviderNames(providers);
  return names.length === 1 ? names[0] : undefined;
}

export function normalizeProviderText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return value.replace(/\s+/g, "").toUpperCase();
}

function providerName(provider: OfficeProviderContext): string | undefined {
  return stringValue(provider.providerName)
    ?? stringValue(provider.name)
    ?? stringValue(provider.displayName)
    ?? stringValue(provider.displayProvider)
    ?? stringValue(provider.fullName);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
