import { assertEquals } from "@std/assert";
import { createSseParser } from "./sse.ts";

function parse(...chunks: string[]) {
  const parser = createSseParser();
  const events = chunks.flatMap((c) => parser.push(c));
  return { events, parser };
}

Deno.test("sse parser: event with type, id and data", () => {
  const { events } = parse('event: progress\nid: 7\ndata: {"n":1}\n\n');
  assertEquals(events, [{ event: "progress", id: "7", data: '{"n":1}' }]);
});

Deno.test("sse parser: default event type is message", () => {
  const { events } = parse("data: hello\n\n");
  assertEquals(events, [{ event: "message", data: "hello" }]);
});

Deno.test("sse parser: accepts LF, CRLF and CR line endings", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    // A trailing byte makes a final CR unambiguous (not half of a CRLF).
    const { events } = parse(`event: a${eol}data: 1${eol}${eol}:end${eol}x`);
    assertEquals(events, [{ event: "a", data: "1" }], JSON.stringify(eol));
  }
});

Deno.test("sse parser: CRLF split across chunks is one line ending", () => {
  const { events } = parse("data: 1\r", "\ndata: 2\r", "\n\r", "\n");
  assertEquals(events, [{ event: "message", data: "1\n2" }]);
});

Deno.test("sse parser: the space after the colon is optional", () => {
  const { events } = parse("event:a\ndata:1\n\n");
  assertEquals(events, [{ event: "a", data: "1" }]);
});

Deno.test("sse parser: only one leading space is removed", () => {
  const { events } = parse("data:  two spaces\n\n");
  assertEquals(events, [{ event: "message", data: " two spaces" }]);
});

Deno.test("sse parser: multiple data lines are joined with LF", () => {
  const { events } = parse("data: line 1\ndata: line 2\ndata\n\n");
  assertEquals(events, [{ event: "message", data: "line 1\nline 2\n" }]);
});

Deno.test("sse parser: comments and unknown fields are ignored", () => {
  const { events } = parse(": keep-alive\nfoo: bar\ndata: 1\n\n");
  assertEquals(events, [{ event: "message", data: "1" }]);
});

Deno.test("sse parser: an event without data is not dispatched", () => {
  const { events } = parse("event: ping\n\ndata: 1\n\n");
  assertEquals(events, [{ event: "message", data: "1" }]);
});

Deno.test("sse parser: an empty data field dispatches an empty string", () => {
  const { events } = parse("data\n\n");
  assertEquals(events, [{ event: "message", data: "" }]);
});

Deno.test("sse parser: event split across arbitrary chunk boundaries", () => {
  const text =
    'event: progress\ndata: {"percent":50}\n\nevent: done\ndata: {}\n\n';
  for (let cut = 1; cut < text.length; cut++) {
    const { events } = parse(text.slice(0, cut), text.slice(cut));
    assertEquals(
      events,
      [
        { event: "progress", data: '{"percent":50}' },
        { event: "done", data: "{}" },
      ],
      `cut at ${cut}`,
    );
  }
});

Deno.test("sse parser: an incomplete event is held until its blank line", () => {
  const parser = createSseParser();
  assertEquals(parser.push("data: 1\n"), []);
  assertEquals(parser.push("\n"), [{ event: "message", data: "1" }]);
});

Deno.test("sse parser: lastEventId persists, per-event id does not", () => {
  const { events, parser } = parse("id: 1\ndata: a\n\ndata: b\n\n");
  assertEquals(events, [
    { event: "message", id: "1", data: "a" },
    { event: "message", data: "b" },
  ]);
  assertEquals(parser.lastEventId, "1");
});

Deno.test("sse parser: an empty id resets lastEventId", () => {
  const { parser } = parse("id: 1\ndata: a\n\nid\ndata: b\n\n");
  assertEquals(parser.lastEventId, "");
});

Deno.test("sse parser: an id containing NUL is ignored", () => {
  const { events, parser } = parse("id: a\0b\ndata: x\n\n");
  assertEquals(events, [{ event: "message", data: "x" }]);
  assertEquals(parser.lastEventId, undefined);
});

Deno.test("sse parser: retry accepts digits only", () => {
  const { parser } = parse("retry: 2500\ndata: a\n\nretry: soon\n\n");
  assertEquals(parser.retry, 2500);
});
