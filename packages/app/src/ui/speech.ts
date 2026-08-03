/**
 * Turning speech into composer text.
 *
 * Binds `expo-speech-recognition` (iOS `SFSpeechRecognizer`, Android
 * `SpeechRecognizer`); the merge rule and the wording of failures live in the
 * Expo-free `../transcription`, which is what `bun test` can actually load.
 *
 * The module is required **lazily inside a `try`** on purpose. It is a native
 * module, so it does not exist in Expo Go — and the project's live-reload loop
 * runs there. A top-level import would turn "dictation is unavailable" into a
 * red screen on launch that takes the whole app down with it. Instead
 * `speechAvailable()` answers false and the composer simply has no mic button.
 */
import { Platform } from "react-native";
import type { EventSubscription } from "expo-modules-core";

type SpeechModule = typeof import("expo-speech-recognition");

let cached: SpeechModule | null | undefined;

function speechModule(): SpeechModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-speech-recognition") as SpeechModule;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Whether this device can dictate at all.
 *
 * Two different "no": the module is missing (Expo Go), or the OS has no
 * recognition service — common on Android builds without Google's app, where
 * `start()` would fail asynchronously with `service-not-allowed` and look like
 * a bug rather than an absence.
 */
export function speechAvailable(): boolean {
  const module = speechModule();
  if (!module) return false;
  try {
    return module.ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export interface DictationHandlers {
  /** Fires repeatedly: each call is a revised transcript of the whole utterance. */
  onTranscript: (transcript: string, isFinal: boolean) => void;
  onError: (code: string) => void;
  onEnd: () => void;
}

export interface DictationSession {
  /** Ask for a final result, then stop. */
  stop: () => void;
  /** Drop the recording without a final result, and release the listeners. */
  cancel: () => void;
}

/**
 * Begin dictating, or explain why not.
 *
 * Returns undefined when permission was refused — the caller has already been
 * told via `onError`, and there is nothing to stop.
 */
export async function startDictation(
  handlers: DictationHandlers,
): Promise<DictationSession | undefined> {
  const module = speechModule();
  if (!module) {
    handlers.onError("service-not-allowed");
    return undefined;
  }
  const { ExpoSpeechRecognitionModule } = module;

  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission.granted) {
    handlers.onError("not-allowed");
    return undefined;
  }

  const subscriptions: EventSubscription[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const subscription of subscriptions) subscription.remove();
  };

  subscriptions.push(
    ExpoSpeechRecognitionModule.addListener("result", (event) => {
      const transcript = event.results[0]?.transcript ?? "";
      handlers.onTranscript(transcript, event.isFinal);
    }),
    ExpoSpeechRecognitionModule.addListener("error", (event) => {
      handlers.onError(event.error);
    }),
    ExpoSpeechRecognitionModule.addListener("end", () => {
      release();
      handlers.onEnd();
    }),
  );

  try {
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      // The draft updates as the user speaks; waiting for a final result would
      // make dictation feel broken for the seconds it takes to arrive.
      interimResults: true,
      // Composing a prompt involves thinking mid-sentence. Without this, iOS 17
      // and earlier end the session after three seconds of quiet.
      continuous: true,
      addsPunctuation: true,
      // iOS has a reliable on-device recogniser and this is a coding prompt,
      // often on a phone with no signal. Android's on-device model is an opt-in
      // download that is frequently absent, so it stays on the default there
      // rather than failing with `language-not-supported`.
      requiresOnDeviceRecognition: Platform.OS === "ios",
      volumeChangeEventOptions: { enabled: false },
    });
  } catch {
    release();
    // A code, not the thrown message: `onError` feeds `dictationMessage`, which
    // is a fixed vocabulary. Passing a native error string through would either
    // fall to the generic line anyway or put raw module wording on screen.
    handlers.onError("audio-capture");
    return undefined;
  }

  return {
    stop: () => {
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {
        // Already stopped; `end` has released the listeners.
      }
    },
    cancel: () => {
      release();
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // Nothing was running.
      }
    },
  };
}
