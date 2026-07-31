export interface ScrollToEndTarget {
  scrollToEnd(options: { animated: boolean }): void;
}

/** Final history replacement must land on the newest message without a visible jump. */
export function alignCompletedHistoryToBottom(target: ScrollToEndTarget | null): void {
  target?.scrollToEnd({ animated: false });
}
