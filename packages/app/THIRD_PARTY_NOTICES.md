# Third-party notices

## unicode-segmenter 0.17.3

https://github.com/cometkim/unicode-segmenter

Copyright (c) 2024 Hyeseong Kim <hey@hyeseong.kim>

Used under the MIT permission and disclaimer reproduced below. Imported via
`unicode-segmenter/grapheme` only; no global Intl polyfill. Installation was
explicitly approved after the native Hermes prototype found no Intl.Segmenter.

## thinking-orbs 0.3.1 and the official native port

https://github.com/Jakubantalik/thinking-orbs

Copyright (c) 2026 Jakub Antalik

`src/ui/ThinkingOrb.tsx` adapts the official React Native renderer at commit
`de85557ca220332586d070d8788c0e1d6e877a0d`, under the MIT permission and disclaimer
reproduced below. It uses the pinned package's 20px engine without changing the
geometry. Local changes use existing lifecycle/accessibility hooks and cap
picture recording at 30 fps. The unpublished native wrapper is kept as source;
no unversioned Git dependency is installed. Skia 2.2.12 is pinned to Expo 54's
compatibility manifest. Both dependency additions were approved by the user.

## assistant-ui smooth reveal lifecycle

Reference: https://github.com/assistant-ui/assistant-ui/blob/14fc93895e3e0c67f84b2722fa2b1180b0341cb3/packages/react/src/utils/smooth/useSmooth.ts

The approved streaming adaptation uses this source's completion, reduced-motion and identity-reset lifecycle alongside GG Coder's pacing. The pinned license was verified from the upstream LICENSE file on 2026-09-20.

MIT License

Copyright (c) 2025 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
