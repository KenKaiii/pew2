import { expect, test } from "bun:test";
import { countProcessesMatching } from "./platform.js";

test("counting processes yields while a slow process-table query is pending", async () => {
  let terminationRan = false;
  const count = countProcessesMatching("owned-child", async () => {
    // Model a scan that cannot finish until the cleanup timer gets CPU time.
    await new Promise<void>((resolve) => setTimeout(() => {
      terminationRan = true;
      resolve();
    }, 10));
    return "unrelated-process\n";
  });
  expect(count).toBeInstanceOf(Promise);
  expect(await count).toBe(0);
  expect(terminationRan).toBe(true);
});

test("process markers are literal text, not shell or regular-expression patterns", async () => {
  const marker = "owned-child[123]";
  expect(await countProcessesMatching(marker, async () =>
    `bun.exe worker.js ${marker}\r\nbun.exe other.js\r\nbun.exe worker.js owned-child1\r\n`,
  )).toBe(1);
});

test("a failed process query cannot pass a no-leak assertion", async () => {
  await expect(countProcessesMatching("owned-child", async () => {
    throw new Error("process table unavailable");
  })).rejects.toThrow("process table unavailable");
});
