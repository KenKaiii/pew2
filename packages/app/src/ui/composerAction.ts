/** Typing a follow-up must never turn its send action into cancellation. */
export function composerAction(busy: boolean, canSend: boolean): "send" | "queue" | "stop" | "none" {
  if (canSend) return busy ? "queue" : "send";
  return busy ? "stop" : "none";
}
