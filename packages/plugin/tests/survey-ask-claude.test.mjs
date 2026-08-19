import assert from "node:assert/strict";
import { test } from "node:test";
import { askClaude } from "../src/kernel/survey/ask-claude.js";

const envelope = (fields) => JSON.stringify({ result: "hello", session_id: "abc", usage: { in: 1 }, total_cost_usd: 0.01, ...fields });

function fakeExec(stdout, opts = {}) {
  return async (_bin, args, input, _execOpts) => {
    if (opts.captureArgs) opts.captureArgs(args, input);
    if (opts.throwError) throw opts.throwError;
    return { stdout, stderr: "" };
  };
}

test("askClaude rejects an empty prompt without calling exec", async () => {
  let called = false;
  await assert.rejects(
    () => askClaude("   ", { exec: async () => { called = true; return { stdout: "{}", stderr: "" }; } }),
    /prompt is required/
  );
  assert.equal(called, false);
});

test("askClaude parses a successful envelope into an AskResult", async () => {
  const result = await askClaude("hi", { exec: fakeExec(envelope({})), findBinary: () => "/bin/claude" });
  assert.equal(result.text, "hello");
  assert.equal(result.sessionId, "abc");
  assert.equal(result.costUsd, 0.01);
  assert.deepEqual(result.usage, { in: 1 });
});

test("askClaude rejects on is_error even when the CLI itself exited cleanly", async () => {
  await assert.rejects(
    () => askClaude("hi", { exec: fakeExec(envelope({ is_error: true, result: "boom" })) }),
    /session error.*boom/
  );
});

test("askClaude rejects on unparseable stdout", async () => {
  await assert.rejects(() => askClaude("hi", { exec: fakeExec("not json") }), /unparseable CLI output/);
});

test("askClaude rejects when exec itself throws", async () => {
  await assert.rejects(
    () => askClaude("hi", { exec: fakeExec("", { throwError: new Error("ENOENT") }) }),
    /askClaude: ENOENT/
  );
});

test("askClaude builds argv with --max-turns 1 by default and excludes dynamic system-prompt sections", async () => {
  let capturedArgs = null;
  await askClaude("hi", {
    exec: fakeExec(envelope({}), { captureArgs: (args) => { capturedArgs = args; } }),
  });
  assert.ok(capturedArgs.includes("--max-turns"));
  assert.equal(capturedArgs[capturedArgs.indexOf("--max-turns") + 1], "1");
  assert.ok(capturedArgs.includes("--exclude-dynamic-system-prompt-sections"));
});

test("askClaude passes the prompt on stdin (input), not as an argv value", async () => {
  let capturedInput = null;
  await askClaude("secret prompt text", {
    exec: async (_bin, _args, input) => { capturedInput = input; return { stdout: envelope({}), stderr: "" }; },
  });
  assert.equal(capturedInput, "secret prompt text");
});

test("askClaude passes --system-prompt through when opts.system is set", async () => {
  let capturedArgs = null;
  await askClaude("hi", {
    system: "Be terse.",
    exec: fakeExec(envelope({}), { captureArgs: (args) => { capturedArgs = args; } }),
  });
  const i = capturedArgs.indexOf("--system-prompt");
  assert.ok(i >= 0);
  assert.equal(capturedArgs[i + 1], "Be terse.");
});
