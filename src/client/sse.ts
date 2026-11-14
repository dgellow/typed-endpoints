/**
 * Incremental parser for the `text/event-stream` format.
 *
 * Follows "Interpreting an event stream" in the WHATWG HTML standard
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
 *
 * - lines end with CRLF, LF or CR
 * - a line starting with `:` is a comment
 * - `field:value` and `field: value` are equivalent (one leading space is
 *   removed); a line without a colon is a field with an empty value
 * - several `data` lines in one event are joined with LF
 * - an empty line dispatches the event, unless it has no `data` line
 *
 * @module
 */

/** An event as it appears on the wire, before the data is decoded. */
export interface RawSseEvent {
  /** Event type. `"message"` when the event has no `event` field. */
  readonly event: string;
  /** Data lines joined with LF. */
  readonly data: string;
  /** Value of the `id` field of this event, if it has one. */
  readonly id?: string;
}

/** Incremental parser. Feed it decoded text, get complete events back. */
export interface SseParser {
  /** Parse a chunk. Returns the events completed by this chunk. */
  push(chunk: string): RawSseEvent[];
  /** Last `id` seen on the stream. Sent as `Last-Event-ID` on reconnect. */
  readonly lastEventId: string | undefined;
  /** Last valid `retry` value seen on the stream, in milliseconds. */
  readonly retry: number | undefined;
  /**
   * Whether the stream carried the comment a server writes when it ends a
   * stream because its handler failed (`SSE_FAILURE_COMMENT`). The stream
   * then closes like any other; this tells the two endings apart.
   */
  readonly failed: boolean;
}

/**
 * The comment line an SSE endpoint of this library writes before it closes
 * a stream whose handler failed.
 *
 * A stream has no status code once it has begun, and a stream that is
 * simply cut loses, on some runtimes, the events that were sent just
 * before. A comment is delivered in order, is ignored by every other
 * event-stream client, and cannot collide with an event name.
 */
export const SSE_FAILURE_COMMENT = ": error";

/** Create a parser for one event stream. */
export function createSseParser(): SseParser {
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];
  let eventId: string | undefined;
  let lastEventId: string | undefined;
  let retry: number | undefined;
  let failed = false;

  function processLine(line: string, out: RawSseEvent[]): void {
    if (line === "") {
      // Dispatch. An event without any data line is dropped.
      if (dataLines.length > 0) {
        out.push({
          event: eventType === "" ? "message" : eventType,
          data: dataLines.join("\n"),
          ...(eventId !== undefined && { id: eventId }),
        });
      }
      eventType = "";
      dataLines = [];
      eventId = undefined;
      return;
    }

    if (line.startsWith(":")) {
      // A comment. One of them says the server gave up on the stream.
      if (line === SSE_FAILURE_COMMENT) failed = true;
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        // An id containing NUL is ignored.
        if (!value.includes("\0")) {
          eventId = value;
          lastEventId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
        // Unknown fields are ignored.
    }
  }

  return {
    push(chunk: string): RawSseEvent[] {
      buffer += chunk;
      const out: RawSseEvent[] = [];

      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;

        // A CR at the very end of the buffer may be the first half of a
        // CRLF split across chunks. Wait for the next chunk to decide.
        if (ch === "\r" && i === buffer.length - 1) break;

        processLine(buffer.slice(start, i), out);
        if (ch === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }

      buffer = buffer.slice(start);
      return out;
    },
    get lastEventId() {
      return lastEventId;
    },
    get retry() {
      return retry;
    },
    get failed() {
      return failed;
    },
  };
}
