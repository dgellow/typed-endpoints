/**
 * Path parameters as parts of a URL.
 *
 * A value is one segment: a slash in it is encoded. That is not enough for
 * `.` and `..`. A URL with such a segment is, once it is normalised, the
 * URL of another path, and it is normalised whether the dots are written
 * out or percent-encoded (WHATWG URL, "single-dot" and "double-dot" path
 * segments). So `notes.retrieve("..")` would ask for the list above the
 * notes, and a delete of `"."` would be a delete of the collection. Those
 * values are refused, and so is an empty one, which names the collection
 * too.
 *
 * @module
 */

/** Whether a segment makes a URL the URL of another path. */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * A path parameter as one segment of a URL.
 *
 * @param describe Says which parameter of which call, for the error.
 * @throws {TypeError} If the value is empty, `.` or `..`.
 */
export function pathSegment(value: unknown, describe: () => string): string {
  const text = String(value);
  if (text === "" || isDotSegment(text)) {
    throw new TypeError(
      `${describe()}: ${
        JSON.stringify(text)
      } cannot be a segment of a path; the request would go to another path`,
    );
  }
  return encodeURIComponent(text);
}

/**
 * A catch-all path parameter: it spans segments, so its slashes are kept
 * and each segment is encoded.
 *
 * @param describe Says which parameter of which call, for the error.
 * @throws {TypeError} If a segment of the value is `.` or `..`.
 */
export function pathRest(value: unknown, describe: () => string): string {
  const segments = String(value).split("/");
  if (segments.some(isDotSegment)) {
    throw new TypeError(
      `${describe()}: ${
        JSON.stringify(String(value))
      } has a segment that is "." or ".."; the request would go to another path`,
    );
  }
  return segments.map(encodeURIComponent).join("/");
}
