/**
 * Pure helpers behind the multi-host picker.
 *
 * A conversation always works on the machine it was opened from (the primary
 * host) plus the extra servers the operator ticks. The server enforces the same
 * cap, so these helpers only keep the UI from offering an impossible selection.
 */
export type HostOption = { id: number; name: string };

/** How many *extra* servers one conversation may add (server cap minus the primary). */
export const MAX_EXTRA_HOSTS = 7;

/**
 * Adds or removes one extra host. The primary host is always part of the
 * conversation, so it is never added to the extra list, and the cap returns the
 * selection unchanged instead of silently dropping an older choice.
 */
export function toggleHost(
  selected: number[],
  id: number,
  primaryId: number,
): number[] {
  if (id === primaryId) return selected;
  if (selected.includes(id)) return selected.filter((value) => value !== id);
  if (selected.length >= MAX_EXTRA_HOSTS) return selected;
  return [...selected, id];
}

/** `主机 3/5` label for the composer button: selected hosts / known hosts. */
export function hostSummary(selected: number[], total: number): string {
  const count = selected.length + 1;
  return total > count ? `主机 ${count}/${total}` : `主机 ${count}`;
}

/**
 * Names of the hosts a turn will touch, primary first. A host that disappeared
 * from the machine list (deleted while the conversation was open) is skipped:
 * the server would refuse it anyway, and showing a stale name would be worse.
 */
export function hostNames(
  extra: number[],
  options: HostOption[],
  primaryName: string,
): string[] {
  const names = [primaryName];
  for (const id of extra) {
    const found = options.find((option) => option.id === id);
    if (found) names.push(found.name);
  }
  return names;
}

/** Hosts offered by the picker: every machine except the primary. */
export function hostChoices(
  options: HostOption[],
  primaryId: number,
): HostOption[] {
  return options.filter((option) => option.id !== primaryId);
}
