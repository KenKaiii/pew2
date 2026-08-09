# Remote-use QA checklist

Bugs seen driving the app remotely (real network, real daemon), plus the test
coverage that would have caught them. A box is ticked only when a test asserts
it. Anything that can only be judged on a device stays open no matter how
confident the change is — "looks fixed" is what produced this list.

Root cause of the whole list: `packages/app/src/useDaemon.ts` is ~2,400 lines of
connection + session state machine with **zero tests**. Every other package has
them (`packages/daemon/src` has 40+). That is why this could only be found by
hand. The fixes below follow the same pattern each time — move the rule into a
pure module beside the hook, test that, and leave the hook holding the socket —
which is the extraction the last section asks for, arriving one bug at a time.

The other half is now `packages/daemon/src/e2e.test.ts`: a real daemon in a real
process, driven over a real socket by a fake phone that performs the same
handshake the app does (`testing/daemon-process.ts`, `testing/app-client.ts`).
Every bug on this list lived *between* the parts rather than inside one, which
is exactly where the unit suites cannot look. It asserts wire facts only — that
the daemon sends the right frame, to the right socket, with enough in it to tell
one client's work from another's. What the app then does with a frame stays in
the pure app-side folds, which are fast and need no processes.

Those scenarios were checked by mutation, not just by passing: breaking the
`requestId` echo, the `working` flag and the replay window each turn the
matching test red and nothing else.

---

## 1. Composer lags when the draft wraps to a new line

**Repro** — focus the chat input, type past the line width or press return.
**Seen** — the box catches up a frame or more after the text; feels like the
animation is dragging the height behind the caret.
**Expected** — growth is instant on wrap; only open/close eases.

Suspect path — `packages/app/src/ui/Composer.tsx:143,155-161,202-213`:

- [x] `contentHeight` came from `onContentSizeChange` → `setState` → re-render →
      new worklet closure → UI thread: a full JS round trip per wrapped line.
      The comment claiming a taller `expandedHeight` "takes effect immediately"
      was wrong on its face — it was a JS-captured value inside
      `useAnimatedStyle` — and has been corrected rather than left to mislead
      the next reader.
- [x] Measured text height is now a `useSharedValue` written straight from the
      event handler, so wrap growth reaches the UI thread without waiting on a
      React commit. The `useState` is kept only for `scrollEnabled`, which is a
      JS-side prop and genuinely needs the render.
- [x] The arithmetic moved to `packages/app/src/ui/composerHeight.ts` as a pure
      worklet, tested in `composerHeight.test.ts`: the floor, the ceiling, and
      the property that matters — a wrap partway through an open adds the whole
      line on that frame instead of phasing it in over the transition.
- [ ] Check the dock: `packages/app/src/dockHeight.ts` + the thread's inset
      change may relayout on the same commit, which is the failure mode the
      `LayoutAnimation` comment at `:186` describes and only partly fixed.
- [ ] Verify on a physical device in a release build. Dev-mode JS is slow enough
      to fake this symptom on its own. **The round trip is gone; that the lag is
      gone with it is not yet measured.**
- [ ] Verify with reduce-motion on and off.

## 2. Slow to connect / did not connect at all, then came online later

**Repro** — cold open the app away from the daemon's network. Sometimes online
in seconds, sometimes stuck, then online with no user action.
**Expected** — either connected fast, or an honest status the user can act on.

Suspect path — `packages/app/src/useDaemon.ts:1471-1500` (`scheduleReconnect`):

- [ ] Backoff caps at 10s and `STALLED_ATTEMPTS` is 4 (~15s) before the UI stops
      saying "connecting". A user who opens the app during attempt 5 waits up to
      10s for a retry that could have been instant.
- [x] A socket stuck half-open (dead radio, captive portal, network switched
      underneath the handshake) now has a 10s deadline that closes it, which
      routes it into `onclose` and the ordinary backoff. Nothing else ever ended
      that state: neither `onclose` nor `onerror` fires, so the app sat in
      `CONNECTING` until iOS timed the connection out minutes later — which is
      exactly the "stuck, then online later with no user action" report.
- [ ] `resumeNow` / foreground resume (`:1597`) still leaves an in-flight
      `CONNECTING` socket alone. The deadline above bounds it, so it recovers on
      its own now; a foreground that finds one should probably not wait.
- [ ] Reset `attempts.current` on network-state change (`NetInfo`), so a walk
      between wifi and cell doesn't inherit an old 10s wait. (It is already
      reset on a successful open.)
- [ ] Distinguish *relay unreachable* from *daemon offline* in the status. The
      user cannot fix the wrong one.
- [ ] Log timings for: app open → socket open → first `ready`. We currently have
      no number for "slow to connect", only a feeling.
- [ ] Confirm the relay side isn't the stall — `bun run relay:check`.

## 3. New session vanished from the drawer, then every session stuck "working"

Worst of the three. Two bugs stacked.

**Repro** — send a prompt that starts a new session → open a different session →
try to return to the first one.
**Seen** — the new session is not in the list, but it is still running. After
that, every row shows the working dot and no session accepts a prompt. Only a
force-quit + relaunch recovers.

The found cause of "returned to nothing, empty" is the third bug in the stack,
and it was not in the list: `session.started` took the screen unconditionally.
It is broadcast to every paired client, carries no transcript, and arrives
seconds after the request — so switching away while an agent booted meant the
answer landed on whatever conversation was being read and blanked it. The
session that caused it was the one with no drawer row, so there was nothing to
go back to. Both halves are fixed below; they were one bug wearing two symptoms.

Suspect path:

- [x] `startSession` posted `session.start` and returned with no local drawer
      entry, on the reasoning that `session.started` would create one. That holds
      only while the frame lands — lose it to a reconnect and the conversation
      was running on the desktop with nothing on the phone pointing at it.
- [x] A provisional entry is now created by the request itself
      (`packages/app/src/pendingSession.ts`, tested), carrying the prompt, and
      the answer adopts that row in place. `session.start` gained a `requestId`
      so the adoption matches this client's own request: the daemon broadcasts
      `session.started` to every paired client, and without it one phone would
      claim the row of a conversation started on another.
- [x] Requests that can no longer be answered are dropped when the socket comes
      back, rather than leaving a row that opens onto nothing and never stops
      pulsing. A session that really was created returns by the slower honest
      route: `activeSessions` and the next history probe.
- [x] **Per-session transcripts.** `session.event` used to be dropped unless it
      matched the visible session, so a conversation that did not claim the
      screen accumulated nothing — switching away while an agent worked meant
      returning to your own prompt and silence, with the answer already
      delivered and discarded. Each session now folds its own chunks into the
      transcript it carries (`replayFold.ts: foldBackgroundEvent`), and reopening
      it paints from that. Reconnect catch-up does the same per session, so
      events missed while the socket was down land in the right conversation
      too.
- [x] One definition of how a chunk becomes a bubble (`replayFold.ts:
      applyChunk`), shared by the live path, the replay fold and background
      sessions. It was three copies of the same twenty lines; a background
      transcript drifting from the visible one would only show up after the user
      switched back, which is the worst place to find it.
- [ ] Global `busy` (`:251`) vs per-session `busy` (`:151`) are both live and
      both write to the same rows. `Sidebar.tsx:245` reads `session.busy`, but
      several writes only touch the global flag. Audit every `busy: true` write
      for a guaranteed clearing path.
- [ ] Find the write that leaves *all* rows busy — likely a per-session map
      updated with the visible session's state, or `busy` set on a session id
      that no longer exists so it is never cleared.
- [x] Reconnect now clears `busy` on every row and then restores it from the
      daemon's own answer, so a stuck dot cannot outlive a reconnect. The daemon
      sends `working` per session in its catch-up because `session.idle` is
      broadcast and never logged — a turn that ended while the phone was away
      replays nothing that says so. Background conversations get the flag
      alongside their missed events, which now land in the transcript they carry
      (`replayFold.ts: foldBackgroundCatchUp`).
- [x] Missed events are replayed on reconnect from a per-session cursor instead
      of resuming silently at the live edge, so a phone that blinked mid-turn no
      longer shows nothing until the agent's next tool call.
- [ ] The floor is still reactive, not absolute: it depends on the daemon
      answering. A session whose daemon never answers has nothing correcting it.
- [x] `session.started` now takes the screen only when the screen is waiting for
      it — the empty new-chat view, this client's own pending row, or a reopen
      this client asked for. A conversation started or reopened on another
      device goes into the drawer and nowhere else. The queued first prompt is
      gated the same way: it was being delivered to whichever session the daemon
      announced next, which could be another device's.
- [ ] Sending must never be blocked app-wide by another session's state. Check
      what disables the send button while `busy`.
- [ ] Repeat the whole flow across a background/foreground cycle and a forced
      socket drop — that is where events go missing.

## 4. General clunkiness

- [ ] Time every user-visible transition on device: session switch, drawer open,
      send → first token, cold start → usable.
- [x] The resume skeleton has a 20s deadline and says what happened when it
      expires. It was the one spinner in the app with nothing to end it: it
      cleared when the transcript arrived, so a resume whose answer was lost hung
      until force-quit. Generous on purpose — a resumed transcript reveals on its
      *first* batch, so anything still waiting at twenty seconds is lost rather
      than slow, and cutting a live resume short would replace a transcript about
      to appear with a failure message.
- [ ] Every *other* spinner still needs the same treatment. Nothing should
      require a force-quit, ever — that is the bar.
- [ ] Audit the app for states only recoverable by relaunch, and add a manual
      "reconnect / reset session state" action.

---

## How we actually test this

Manual passes will not hold this. Priority order:

- [ ] **Extract the reducer out of `useDaemon.ts`.** Pure
      `(state, wireMessage) → state` in its own module, hook keeps only the
      socket and effects. This is the unlock — bugs 2 and 3 become plain bun
      tests, no device, no network. Partly begun: `replayFold.ts`,
      `pendingSession.ts` and `cursors.ts` are the reducer's rules for the cases
      above, pure and tested. The socket handler itself is still untested.
- [x] **Real daemon, real socket, fake phone** — `packages/daemon/src/e2e.test.ts`
      with `testing/daemon-process.ts` and `testing/app-client.ts`. Fourteen
      scenarios covering the handshake, the single-device claim, a full prompt
      against a real ACP agent, fan-out to a second socket, a socket killed
      mid-turn and caught up, cursor de-duplication, and cancellation. Runs in
      about eight seconds as part of `bun run test`, needs no API key and no
      network.
- [ ] The app-side half of the same scenarios. The wire is now covered; what
      `useDaemon` *does* with those frames still is not, and that is the
      extraction above rather than more processes.
- [ ] **Invariant tests** run after every scripted scenario:
      no session busy without an in-flight turn; every started session appears
      exactly once in the drawer; send is never globally disabled.
- [ ] **Chaos/property test** over a random stream of connects, drops,
      backgrounding, session starts and prompts — assert the invariants hold at
      every step. This is what finds the stuck-working state.
- [ ] **Connection tests with a fake clock** — backoff schedule, stall
      threshold, resume behaviour, timeout on a half-open socket.
- [ ] **E2E on a simulator** (Maestro — no runner exists yet) for the flows unit
      tests cannot reach: send → new session → switch → return; kill the daemon
      mid-turn; airplane mode toggle.
- [ ] **Perf gate** for the composer using the existing harness pattern
      (`ui/Composer.harness.tsx`) — measure wrap-growth latency in a release
      build rather than describing it.
- [ ] **Log timings from the real device** into `crashLog.ts` so remote sessions
      produce evidence instead of anecdotes.

## Short manual smoke pass

Only for what automation cannot reach. Should take under five minutes.

- [ ] Cold start on cell data, away from the daemon's network → connects.
- [ ] Type a multi-line prompt → box grows with the text, no lag.
- [ ] Send → new session → switch away → switch back. Session is in the drawer.
- [ ] Background 60s → foreground → still connected, still able to send.
- [ ] Kill wifi mid-turn → reconnects and the transcript is gap-free.
- [ ] No session stuck working after any of the above.
