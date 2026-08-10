import { expect, test } from "bun:test";
import { linkTarget } from "./links";

test("web pages open in the in-app browser", () => {
  expect(linkTarget("https://example.com/docs")).toBe("browser");
  expect(linkTarget("http://localhost:8787/health")).toBe("browser");
  // Scheme comparison is case-insensitive, and markdown carries whatever the
  // agent typed.
  expect(linkTarget("HTTPS://Example.com")).toBe("browser");
  expect(linkTarget("  https://example.com  ")).toBe("browser");
});

test("schemes only the OS can service go to the OS", () => {
  expect(linkTarget("mailto:someone@example.com")).toBe("external");
  expect(linkTarget("tel:+15551234567")).toBe("external");
  // An agent citing a file it read, and a deep link into another app.
  expect(linkTarget("file:///Users/me/project/README.md")).toBe("external");
  expect(linkTarget("vscode://file/Users/me/project/src/index.ts")).toBe("external");
});

test("executable and inline schemes are never opened", () => {
  // Message text is the agent's, not the user's: these can appear in a
  // transcript without anyone choosing to put them there.
  expect(linkTarget("javascript:alert(1)")).toBe("unsupported");
  expect(linkTarget("JavaScript:alert(1)")).toBe("unsupported");
  expect(linkTarget("data:text/html,<script>alert(1)</script>")).toBe("unsupported");
  expect(linkTarget("vbscript:msgbox(1)")).toBe("unsupported");
  expect(linkTarget("blob:https://example.com/1234")).toBe("unsupported");
});

test("anything without a scheme has nothing to resolve against", () => {
  expect(linkTarget("example.com")).toBe("unsupported");
  expect(linkTarget("/docs/getting-started")).toBe("unsupported");
  expect(linkTarget("#heading")).toBe("unsupported");
  expect(linkTarget("")).toBe("unsupported");
});
