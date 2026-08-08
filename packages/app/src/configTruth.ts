/**
 * Which selectors the pills are allowed to name, and where they come from.
 *
 * The model shown has to be the model that runs. There are two different lists
 * in play — the one a live conversation reports, and the one a *new*
 * conversation would open with — and quietly showing whichever arrived last is
 * how a pill ends up naming a model the next prompt will not use.
 *
 * Pure and react-free so the rule is directly testable: the failure it prevents
 * is invisible in a typecheck and looks perfectly normal on screen.
 */
import type { ConfigOption } from "./useDaemon";

/**
 * What a new conversation with each agent will open with.
 *
 * Only ever written from what the daemon says about the *provider*: its
 * capability reply, and its announcement that a provider-level choice changed.
 * A live conversation's own list is not a source — a resumed one comes back at
 * the selectors it was last used with, which need not be the remembered ones.
 */
export function rememberConfigs(
  known: Record<string, ConfigOption[]>,
  providerId: string | undefined,
  options: ConfigOption[],
): Record<string, ConfigOption[]> {
  if (!providerId || options.length === 0) return known;
  return { ...known, [providerId]: options };
}

/** Apply one chosen value to a remembered list, leaving the rest alone. */
export function withChoice(
  options: ConfigOption[],
  configId: string,
  value: string | boolean,
): ConfigOption[] {
  return options.map((option) =>
    option.id === configId ? { ...option, currentValue: value } : option,
  );
}

/**
 * The list the pills must render.
 *
 * In order: the open conversation's own selectors, which are the only truth
 * about it; nothing at all while a conversation is open but has not said yet,
 * since a restored one comes back at whatever it was last used with and the
 * provider's remembered value would be a guess dressed as a fact; otherwise the
 * provider's, which is exactly what the next prompt will use.
 *
 * The empty middle case is the point. A pill that names the wrong model is worse
 * than no pill: nobody acts on an absent label, and everybody acts on a wrong
 * one.
 */
export function visibleConfigs({
  session,
  provider,
  inConversation,
}: {
  session: ConfigOption[];
  provider: ConfigOption[] | undefined;
  /** A conversation is open or being restored — whether or not it has reported. */
  inConversation: boolean;
}): ConfigOption[] {
  if (session.length > 0) return session;
  if (inConversation) return [];
  return provider ?? [];
}
