/**
 * Dev-only visual harness for the crash screen.
 *
 * This is the one screen that cannot be reached by using the app correctly, so
 * without a harness it ships unlooked-at — and a broken error screen is only
 * discovered by someone already having a bad time.
 *
 * Not reachable from the app; point index.ts here and run `npx expo start --web`.
 */
import { useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb({ armed }: { armed: boolean }): React.ReactElement {
  if (armed) throw new Error("Simulated render failure: cannot read property 'id' of undefined");
  // Unreachable in the harness, which always arms it.
  return <></>;
}

export default function ErrorBoundaryHarness() {
  const [armed] = useState(true);
  return (
    <ErrorBoundary>
      <Bomb armed={armed} />
    </ErrorBoundary>
  );
}
