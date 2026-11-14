import { assertEquals, assertThrows } from "@std/assert";

import { pathRest, pathSegment } from "./path_segment.ts";

const where = () => 'notes.retrieve: the path parameter "id" of /notes/{id}';

Deno.test("path segment: a value is one segment, whatever is in it", () => {
  assertEquals(pathSegment("n1", where), "n1");
  assertEquals(pathSegment("a b/c?d", where), "a%20b%2Fc%3Fd");
  assertEquals(pathSegment(42, where), "42");
  // Dots inside a name are a name.
  assertEquals(pathSegment("v1.2", where), "v1.2");
  assertEquals(pathSegment("...", where), "...");
  // Already encoded dots are text: the percent sign is encoded.
  assertEquals(pathSegment("%2e%2e", where), "%252e%252e");
});

Deno.test("path segment: a value that names another path is refused", () => {
  for (const value of ["..", ".", ""]) {
    assertThrows(
      () => pathSegment(value, where),
      TypeError,
      `notes.retrieve: the path parameter "id" of /notes/{id}: ${
        JSON.stringify(value)
      } cannot be a segment of a path`,
    );
  }
});

Deno.test("path segment: a URL with a dot segment is the URL of another path", () => {
  // Why the values are refused and not encoded: the URL parser removes
  // the segment, also when it is percent-encoded.
  assertEquals(new URL("http://api/notes/..").pathname, "/");
  assertEquals(new URL("http://api/notes/%2e%2e").pathname, "/");
  assertEquals(new URL("http://api/notes/.").pathname, "/notes/");
  assertEquals(new URL("http://api/notes/%2E").pathname, "/notes/");
});

Deno.test("path segment: a catch-all keeps its slashes and refuses dot segments", () => {
  assertEquals(pathRest("docs/a b.txt", where), "docs/a%20b.txt");
  assertEquals(pathRest("", where), "");
  for (const value of ["../../admin", "a/./b", "a/..", ".."]) {
    assertThrows(() => pathRest(value, where), TypeError, 'is "." or ".."');
  }
});
