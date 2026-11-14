/**
 * Affine sessions: a session can be dropped, and the protocol says what
 * happens then.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  createSession,
  dependentStep,
  fromStep,
  mappedStep,
  protocol,
  protocolToOpenApi,
  SessionAbandonedError,
  SessionEndedError,
  step,
  type StepExecutor,
  validateProtocol,
} from "./index.ts";

// =============================================================================
// A file: open, read, close
// =============================================================================

const open = step({
  name: "open",
  request: z.object({ path: z.string() }),
  response: z.object({ handle: z.string() }),
});

const read = mappedStep({
  name: "read",
  dependsOn: "open",
  requestMapping: { handle: fromStep("open", "handle") },
  requestSchema: z.object({ handle: z.string(), bytes: z.number() }),
  response: z.object({ data: z.string() }),
});

const close = mappedStep({
  name: "close",
  dependsOn: "open",
  requestMapping: { handle: fromStep("open", "handle") },
  requestSchema: z.object({ handle: z.string() }),
  response: z.object({ closed: z.literal(true) }),
});

const files = protocol({
  name: "Files",
  initial: "open",
  terminal: ["close"],
  onAbandon: "close",
  steps: { open, read, close },
});

/** An executor that records every call and counts open handles. */
function fileSystem(options: { failClose?: boolean } = {}) {
  const calls: { step: string; request: unknown }[] = [];
  const handles = new Set<string>();
  let next = 0;
  const executor: StepExecutor = {
    execute: <T>(name: string, request: unknown): Promise<T> => {
      calls.push({ step: name, request });
      const { handle } = request as { handle: string };
      let response: unknown;
      if (name === "open") {
        const opened = `h${++next}`;
        handles.add(opened);
        response = { handle: opened };
      } else if (name === "read") {
        response = { data: handles.has(handle) ? "bytes" : "" };
      } else {
        if (options.failClose) throw new Error("disk went away");
        handles.delete(handle);
        response = { closed: true };
      }
      return Promise.resolve(response as T);
    },
  };
  return { executor, calls, handles, steps: () => calls.map((c) => c.step) };
}

// =============================================================================
// Leaving the block
// =============================================================================

Deno.test("abandon: leaving the block after open sends close, once", async () => {
  const fs = fileSystem();
  {
    await using session = createSession(files, fs.executor);
    await session.execute("open", { path: "/tmp/a" });
    assertEquals(fs.handles.size, 1);
  }

  assertEquals(fs.steps(), ["open", "close"]);
  // With the handle `open` returned: the session filled the request in.
  assertEquals(fs.calls[1].request, { handle: "h1" });
  assertEquals(fs.handles.size, 0);
});

Deno.test("abandon: the step runs on the state the session reached", async () => {
  const fs = fileSystem();
  {
    // The bound value is the first one; the steps ran on later values.
    await using session = createSession(files, fs.executor);
    const opened = await session.execute("open", { path: "/tmp/a" });
    await opened.session.execute("read", { handle: "h1", bytes: 8 });
    await opened.session.execute("read", { handle: "h1", bytes: 8 });
  }
  assertEquals(fs.steps(), ["open", "read", "read", "close"]);
  assertEquals(fs.handles.size, 0);
});

Deno.test("abandon: a session that reached a terminal step sends nothing", async () => {
  const fs = fileSystem();
  {
    await using session = createSession(files, fs.executor);
    const opened = await session.execute("open", { path: "/tmp/a" });
    const closed = await opened.session.execute("close", { handle: "h1" });
    assertEquals(closed.session.isTerminal(), true);
  }
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: a session on which nothing ran sends nothing", async () => {
  const fs = fileSystem();
  {
    await using _session = createSession(files, fs.executor);
  }
  assertEquals(fs.steps(), []);
});

Deno.test("abandon: an error that leaves the block still closes, and is the error thrown", async () => {
  const fs = fileSystem();
  const error = await assertRejects(async () => {
    await using session = createSession(files, fs.executor);
    await session.execute("open", { path: "/tmp/a" });
    throw new RangeError("parse failed");
  }, RangeError);

  assertEquals(error.message, "parse failed");
  assertEquals(fs.steps(), ["open", "close"]);
  assertEquals(fs.handles.size, 0);
});

Deno.test("abandon: every value of a session ends the same session", async () => {
  const fs = fileSystem();
  const first = createSession(files, fs.executor);
  const opened = await first.execute("open", { path: "/tmp/a" });

  // Ended through a later value, with what was run as the result.
  const released = await opened.session.abandon();
  assertEquals(released, {
    step: "close",
    request: { handle: "h1" },
    response: { closed: true },
  });

  // Ending it again, through any value, does nothing.
  assertEquals(await first.abandon(), undefined);
  assertEquals(await opened.session.abandon(), undefined);
  await first[Symbol.asyncDispose]();
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: a session that was ended executes nothing", async () => {
  const fs = fileSystem();
  const first = createSession(files, fs.executor);
  const opened = await first.execute("open", { path: "/tmp/a" });
  await first.abandon();

  const error = await assertRejects(
    () => opened.session.execute("read", { handle: "h1", bytes: 1 }),
    SessionEndedError,
  );
  assertEquals(error.step, "read");
  await assertRejects(
    () => first.execute("open", { path: "/tmp/b" }),
    SessionEndedError,
  );
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: single-use sessions are ended through a spent value", async () => {
  const fs = fileSystem();
  {
    await using session = createSession(files, fs.executor, {
      singleUse: true,
    });
    const opened = await session.execute("open", { path: "/tmp/a" });
    await opened.session.execute("read", { handle: "h1", bytes: 8 });
  }
  assertEquals(fs.steps(), ["open", "read", "close"]);
});

Deno.test("abandon: a fork is followed along the value that ran last", async () => {
  const fs = fileSystem();
  const first = createSession(files, fs.executor);
  // Two steps on the same value: two files, one session.
  await first.execute("open", { path: "/tmp/a" });
  await first.execute("open", { path: "/tmp/b" });
  await first.abandon();

  // The later branch is released; the earlier one is not known any more.
  assertEquals(fs.calls.at(-1), { step: "close", request: { handle: "h2" } });
  assertEquals([...fs.handles], ["h1"]);

  // `singleUse` refuses the second step, so there is nothing to lose.
  const strict = createSession(files, fs.executor, { singleUse: true });
  await strict.execute("open", { path: "/tmp/c" });
  await assertRejects(() => strict.execute("open", { path: "/tmp/d" }));
});

Deno.test("abandon: a close that fails is the error of the block, and is not retried", async () => {
  const fs = fileSystem({ failClose: true });
  const session = createSession(files, fs.executor);
  await session.execute("open", { path: "/tmp/a" });

  await assertRejects(() => session.abandon(), Error, "disk went away");
  assertEquals(await session.abandon(), undefined);
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: a protocol without onAbandon ends without a step", async () => {
  const plain = protocol({
    name: "Plain",
    initial: "open",
    terminal: ["close"],
    steps: { open, read, close },
  });
  const fs = fileSystem();
  {
    await using session = createSession(plain, fs.executor);
    await session.execute("open", { path: "/tmp/a" });
  }
  assertEquals(fs.steps(), ["open"]);
});

// =============================================================================
// Linear sessions
// =============================================================================

Deno.test("abandon: a linear session that is left early closes, then throws", async () => {
  const fs = fileSystem();
  const error = await assertRejects(async () => {
    await using session = createSession(files, fs.executor, { linear: true });
    const opened = await session.execute("open", { path: "/tmp/a" });
    await opened.session.execute("read", { handle: "h1", bytes: 8 });
  }, SessionAbandonedError);

  assertEquals(error.history, ["open", "read"]);
  assertEquals(error.released, "close");
  assertEquals(error.protocol, "Files");
  assertEquals(
    error.message,
    'Session ended after "read", which is not a terminal step of "Files" ("close" was run)',
  );
  // The handle was released before the error.
  assertEquals(fs.steps(), ["open", "read", "close"]);
  assertEquals(fs.handles.size, 0);
});

Deno.test("abandon: a linear session that completes, or never starts, does not throw", async () => {
  const fs = fileSystem();
  {
    await using session = createSession(files, fs.executor, { linear: true });
    const opened = await session.execute("open", { path: "/tmp/a" });
    await opened.session.execute("close", { handle: "h1" });
  }
  {
    await using _session = createSession(files, fs.executor, { linear: true });
  }
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: a linear session's error does not hide the error of the block", async () => {
  const fs = fileSystem();
  const error = await assertRejects(async () => {
    await using session = createSession(files, fs.executor, { linear: true });
    await session.execute("open", { path: "/tmp/a" });
    throw new RangeError("parse failed");
  });

  // Both are reported: the disposal error suppresses the block's error,
  // which stays reachable.
  assert(error instanceof SuppressedError);
  assert(error.error instanceof SessionAbandonedError);
  assert(error.suppressed instanceof RangeError);
  assertEquals(fs.steps(), ["open", "close"]);
});

// =============================================================================
// Which steps a session can run by itself
// =============================================================================

Deno.test("abandon: onAbandon accepts only a step the session can fill in", () => {
  const logout = step({
    name: "logout",
    request: z.object({ everywhere: z.boolean().optional() }),
    response: z.object({}),
  });
  const after = dependentStep({
    name: "after",
    dependsOn: "open",
    request: () => z.object({}),
    response: z.object({}),
  });
  const steps = { open, read, close, logout, after };

  // A step without required fields: the request is `{}`.
  const viaLogout = protocol({
    name: "ViaLogout",
    initial: "open",
    onAbandon: "logout",
    steps,
  });
  assertEquals(validateProtocol(viaLogout), { valid: true, errors: [] });

  const viaRead = protocol({
    name: "ViaRead",
    initial: "open",
    // @ts-expect-error `bytes` is required and no mapping fills it in
    onAbandon: "read",
    steps,
  });
  assertEquals(validateProtocol(viaRead).errors, [
    'onAbandon step "read" requires "bytes", which no mapping fills in',
  ]);

  const viaOpen = protocol({
    name: "ViaOpen",
    initial: "open",
    // @ts-expect-error `path` is required
    onAbandon: "open",
    steps,
  });
  assertEquals(validateProtocol(viaOpen).errors, [
    'onAbandon step "open" has required request fields; a session can only run it with an empty request',
  ]);

  const viaDependent = protocol({
    name: "ViaDependent",
    initial: "open",
    // @ts-expect-error the request of a dependent step is a function
    onAbandon: "after",
    steps,
  });
  assertEquals(validateProtocol(viaDependent).errors, [
    'onAbandon step "after" is not a step or a mapped step; a session cannot derive its request',
  ]);

  const viaNothing = protocol({
    name: "ViaNothing",
    initial: "open",
    // @ts-expect-error not a step of the protocol
    onAbandon: "shutdown",
    steps,
  });
  assertEquals(validateProtocol(viaNothing).errors, [
    'onAbandon step "shutdown" not found in steps',
  ]);
});

Deno.test("abandon: a step without required fields is run with an empty request", async () => {
  const login = step({
    name: "login",
    request: z.object({ user: z.string() }),
    response: z.object({ token: z.string() }),
  });
  const logout = step({
    name: "logout",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
  });
  const auth = protocol({
    name: "Auth",
    initial: "login",
    terminal: ["logout"],
    onAbandon: "logout",
    steps: { login, logout },
  });

  const calls: [string, unknown][] = [];
  const executor: StepExecutor = {
    execute: <T>(name: string, request: unknown) => {
      calls.push([name, request]);
      return Promise.resolve(
        (name === "login" ? { token: "t" } : { ok: true }) as T,
      );
    },
  };
  {
    await using session = createSession(auth, executor);
    await session.execute("login", { user: "ada" });
  }
  assertEquals(calls, [["login", { user: "ada" }], ["logout", {}]]);
});

Deno.test("abandon: the step is skipped when it cannot run in the state reached", async () => {
  // `ping` runs first; `close` depends on `open`, which did not run.
  const ping = step({
    name: "ping",
    request: z.object({}),
    response: z.object({ pong: z.literal(true) }),
  });
  const pinged = protocol({
    name: "Pinged",
    initial: "ping",
    terminal: ["close"],
    onAbandon: "close",
    steps: { ping, open, close },
  });
  const seen: string[] = [];
  const executor: StepExecutor = {
    execute: <T>(name: string) => {
      seen.push(name);
      return Promise.resolve({ pong: true } as T);
    },
  };

  const session = createSession(pinged, executor);
  await session.execute("ping", {});
  assertEquals(await session.abandon(), undefined);
  assertEquals(seen, ["ping"]);

  // Linear: nothing to release, and still not complete.
  const strict = createSession(pinged, executor, { linear: true });
  await strict.execute("ping", {});
  const error = await assertRejects(
    () => strict.abandon(),
    SessionAbandonedError,
  );
  assertEquals(error.released, undefined);
  assertEquals(
    error.message,
    'Session ended after "ping", which is not a terminal step of "Pinged"',
  );
});

Deno.test("abandon: a protocol spread into another keeps its onAbandon", async () => {
  const stat = step({
    name: "stat",
    request: z.object({ path: z.string() }),
    response: z.object({ size: z.number() }),
  });

  // More steps: `close` is still a step the session can fill in.
  const more = protocol({ ...files, steps: { ...files.steps, stat } });
  assertEquals(more.onAbandon, "close");

  const fs = fileSystem();
  {
    await using session = createSession(more, fs.executor);
    await session.execute("open", { path: "/tmp/a" });
  }
  assertEquals(fs.steps(), ["open", "close"]);
});

Deno.test("abandon: x-protocol names the step", () => {
  assertEquals(protocolToOpenApi(files).onAbandon, "close");
});
