export interface ApprovalOption {
  optionId: string;
  name: string;
}

export function isDenyApprovalOption(option: ApprovalOption): boolean {
  return /reject|deny|no/i.test(option.optionId);
}

/**
 * The dock intentionally offers one temporary approval and one rejection.
 * Persistent "always allow" grants belong in provider settings, not a compact
 * blocking prompt where a long generated label can displace the safe choice.
 */
export function selectApprovalOptions(options: readonly ApprovalOption[]): ApprovalOption[] {
  const deny = options.find(isDenyApprovalOption);
  const allowOnce = options.find(
    (option) =>
      !isDenyApprovalOption(option) &&
      !/always|permanent|persist/i.test(`${option.optionId} ${option.name}`),
  );
  const selected = [allowOnce, deny].filter(
    (option): option is ApprovalOption => option !== undefined,
  );

  for (const option of options) {
    if (selected.length >= 2) break;
    if (!selected.some((candidate) => candidate.optionId === option.optionId)) selected.push(option);
  }
  return selected.slice(0, 2);
}
