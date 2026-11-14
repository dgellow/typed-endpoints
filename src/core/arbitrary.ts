/**
 * Values from schemas.
 *
 * `arbitrary(schema)` returns a value the schema accepts, chosen by a
 * seeded random number generator: the same seed gives the same value. It
 * is what lets a protocol be exercised without hand-written requests (see
 * `protocol/fuzz.ts`).
 *
 * The value is built from the schema's structure and checks, then parsed
 * with the schema. A schema whose constraints the generator cannot read (a
 * `refine()`, a regular expression) is retried with other values and, if
 * none passes, reported with the path of the part that failed.
 *
 * @module
 */

import type { z } from "zod";

import {
  isOptionalField,
  zodChecks,
  zodDef,
  zodInternals,
  zodType,
} from "./zod_internals.ts";

/** A source of numbers in `[0, 1)`. */
export type Random = () => number;

/**
 * A deterministic random number generator (mulberry32).
 *
 * @param seed Any integer; the same seed gives the same sequence.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Options of `arbitrary()`. */
export interface ArbitraryOptions {
  /** Seed of the generator. Default: 0. Ignored when `random` is given. */
  readonly seed?: number;
  /** The generator to draw from, to continue a sequence across calls. */
  readonly random?: Random;
  /**
   * How many values to try before giving up on a schema with constraints
   * the generator cannot read. Default: 100.
   */
  readonly attempts?: number;
  /**
   * Nesting depth after which optional parts are left out and lists are
   * empty, so a recursive schema ends. Default: 4.
   */
  readonly maxDepth?: number;
}

/** No value could be generated for a schema. */
export class ArbitraryError extends Error {
  /**
   * Create the error.
   *
   * @param message What failed.
   * @param path Where in the schema, e.g. `items.0.email`.
   */
  constructor(
    message: string,
    /** Where in the schema, e.g. `items.0.email`. */
    readonly path: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ArbitraryError";
  }
}

/**
 * A value the schema accepts as input.
 *
 * @param schema Any Zod schema.
 * @param options Seed and limits.
 */
export function arbitrary<T extends z.ZodType>(
  schema: T,
  options: ArbitraryOptions = {},
): z.input<T> {
  const random = options.random ?? seededRandom(options.seed ?? 0);
  const attempts = options.attempts ?? 100;
  const gen = new Generator(random, options.maxDepth ?? 4);

  let lastIssue = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = gen.value(schema, "", 0);
    const parsed = schema.safeParse(value);
    if (parsed.success) return value as z.input<T>;
    const issue = parsed.error.issues[0];
    lastIssue = `${issue.path.join(".")}: ${issue.message}`;
  }
  throw new ArbitraryError(
    `no accepted value in ${attempts} attempts (last rejection: ${lastIssue})`,
    "",
  );
}

// =============================================================================
// Generator
// =============================================================================

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";

/** Marks an object key to leave out. */
const OMIT = Symbol("omit");

class Generator {
  constructor(
    private readonly random: Random,
    private readonly maxDepth: number,
  ) {}

  // ---------------------------------------------------------------------------
  // Draws
  // ---------------------------------------------------------------------------

  /** An integer in `[min, max]`. */
  private int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  private chance(probability: number): boolean {
    return this.random() < probability;
  }

  private pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  private chars(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.pick([...alphabet]);
    return out;
  }

  private word(min = 3, max = 8): string {
    return this.chars(LETTERS, this.int(min, max));
  }

  // ---------------------------------------------------------------------------
  // Schemas
  // ---------------------------------------------------------------------------

  /** A value for an object key, or `OMIT` to leave the key out. */
  private field(schema: unknown, path: string, depth: number): unknown {
    if (
      isOptionalField(schema, "input") &&
      (depth >= this.maxDepth || this.chance(0.3))
    ) {
      return OMIT;
    }
    return this.value(schema, path, depth);
  }

  value(schema: unknown, path: string, depth: number): unknown {
    const def = zodDef(schema);
    const type = zodType(schema);
    const deep = depth >= this.maxDepth;
    const at = (key: string | number) => path ? `${path}.${key}` : `${key}`;

    switch (type) {
      case "string":
        return this.string(schema);
      case "number":
        return this.number(schema);
      case "int":
        return this.number(schema);
      case "bigint":
        return BigInt(this.int(-1000, 1000));
      case "boolean":
        return this.chance(0.5);
      case "null":
        return null;
      case "undefined":
      case "void":
        return undefined;
      case "nan":
        return Number.NaN;
      case "symbol":
        return Symbol(this.word());
      case "date":
        return this.date(schema);
      case "any":
      case "unknown":
        return this.pick([null, true, this.int(0, 100), this.word()]);
      case "never":
        throw new ArbitraryError("`never` has no value", path);

      case "literal":
        return this.pick(def.values as unknown[]);
      case "enum":
        return this.pick(Object.values(def.entries as object));
      case "template_literal":
        return (def.parts as unknown[]).map((part, i) =>
          zodType(part) === undefined
            ? String(part)
            : String(this.value(part, at(i), depth + 1))
        ).join("");

      case "optional":
        return deep || this.chance(0.3)
          ? undefined
          : this.value(def.innerType, path, depth);
      case "nullable":
        return deep || this.chance(0.2)
          ? null
          : this.value(def.innerType, path, depth);
      case "default":
      case "prefault":
        return this.chance(0.3)
          ? undefined
          : this.value(def.innerType, path, depth);
      case "nonoptional": {
        for (let i = 0; i < 20; i++) {
          const value = this.value(def.innerType, path, 0);
          if (value !== undefined) return value;
        }
        throw new ArbitraryError("no defined value", path);
      }
      case "catch":
      case "readonly":
      case "success":
        return this.value(def.innerType, path, depth);
      case "lazy":
        return this.value((def.getter as () => unknown)(), path, depth + 1);
      case "pipe": {
        // `z.stringbool()` is a pipe from the strings it lists.
        const bag = zodInternals(schema).bag as
          | { truthy?: unknown[]; falsy?: unknown[] }
          | undefined;
        if (bag?.truthy && bag.falsy) {
          return this.pick([...bag.truthy, ...bag.falsy]);
        }
        // The input end describes what to send. `z.preprocess()` has a
        // transform there: what it accepts is not known, so the output
        // end's type is the best guess.
        // The same for a pipe from `unknown` or `any` (a check in front of
        // a schema): the output end says what the value looks like.
        const inType = zodType(def.in);
        const input =
          inType === "transform" || inType === "unknown" || inType === "any"
            ? def.out
            : def.in;
        return this.value(input, path, depth);
      }

      case "array": {
        const { min, max } = this.sizes(schema, deep);
        return Array.from(
          { length: this.int(min, max) },
          (_, i) => this.value(def.element, at(i), depth + 1),
        );
      }
      case "set": {
        const { min, max } = this.sizes(schema, deep);
        const set = new Set<unknown>();
        const size = this.int(min, max);
        for (let i = 0; set.size < size && i < size * 10; i++) {
          set.add(this.value(def.valueType, at(i), depth + 1));
        }
        return set;
      }
      case "map": {
        const map = new Map<unknown, unknown>();
        const size = deep ? 0 : this.int(0, 2);
        for (let i = 0; i < size; i++) {
          map.set(
            this.value(def.keyType, at(i), depth + 1),
            this.value(def.valueType, at(i), depth + 1),
          );
        }
        return map;
      }
      case "tuple": {
        const items = (def.items as unknown[]).map((item, i) =>
          this.value(item, at(i), depth + 1)
        );
        if (def.rest && !deep) {
          const extra = this.int(0, 2);
          for (let i = 0; i < extra; i++) {
            items.push(
              this.value(def.rest, at(items.length), depth + 1),
            );
          }
        }
        return items;
      }
      case "object": {
        const out: Record<string, unknown> = {};
        for (
          const [key, field] of Object.entries(def.shape as object)
        ) {
          const value = this.field(field, at(key), depth + 1);
          if (value !== OMIT) out[key] = value;
        }
        return out;
      }
      case "record": {
        const out: Record<string, unknown> = {};
        const keyType = zodType(def.keyType);
        // A record over an enum or literal needs every key.
        const keys: unknown[] = keyType === "enum"
          ? Object.values(zodDef(def.keyType).entries as object)
          : keyType === "literal"
          ? zodDef(def.keyType).values as unknown[]
          : Array.from(
            { length: deep ? 0 : this.int(0, 2) },
            (_, i) => this.value(def.keyType, at(i), depth + 1),
          );
        for (const key of keys) {
          out[String(key)] = this.value(
            def.valueType,
            at(String(key)),
            depth + 1,
          );
        }
        return out;
      }
      case "union": {
        const options = def.options as unknown[];
        // Past the depth limit, the first option: by convention the base
        // case of a recursive union.
        const option = deep ? options[0] : this.pick(options);
        return this.value(option, path, depth);
      }
      case "intersection": {
        const left = this.value(def.left, path, depth);
        const right = this.value(def.right, path, depth);
        return isPlainObject(left) && isPlainObject(right)
          ? { ...left, ...right }
          : left;
      }

      default:
        throw new ArbitraryError(
          `no generator for schema type ${JSON.stringify(type)}`,
          path,
        );
    }
  }

  /** Bounds on the number of elements, from the checks. */
  private sizes(schema: unknown, deep: boolean): { min: number; max: number } {
    let min = 0;
    let max: number | undefined;
    for (const check of zodChecks(schema)) {
      if (check.check === "min_length" || check.check === "min_size") {
        min = Math.max(min, check.minimum as number);
      } else if (check.check === "max_length" || check.check === "max_size") {
        max = Math.min(max ?? Infinity, check.maximum as number);
      } else if (
        check.check === "length_equals" || check.check === "size_equals"
      ) {
        min = (check.length ?? check.size) as number;
        max = min;
      }
    }
    const preferred = deep ? min : min + 3;
    return { min, max: Math.max(min, Math.min(max ?? preferred, preferred)) };
  }

  private number(schema: unknown): number {
    let min = -1000;
    let max = 1000;
    let integer = zodType(schema) === "int";
    let step: number | undefined;
    let exclusiveMin = false;
    let exclusiveMax = false;

    for (const check of zodChecks(schema)) {
      switch (check.check) {
        case "number_format":
          if (check.format !== "float32" && check.format !== "float64") {
            integer = true;
          }
          if (check.format === "uint32") min = Math.max(min, 0);
          break;
        case "greater_than":
          min = check.value as number;
          exclusiveMin = check.inclusive !== true;
          if (max < min) max = min + 1000;
          break;
        case "less_than":
          max = check.value as number;
          exclusiveMax = check.inclusive !== true;
          if (min > max) min = max - 1000;
          break;
        case "multiple_of":
          step = check.value as number;
          break;
      }
    }

    if (step !== undefined) {
      const lowest = Math.ceil(min / step) + (exclusiveMin ? 1 : 0);
      const highest = Math.floor(max / step) - (exclusiveMax ? 1 : 0);
      return this.int(lowest, Math.max(lowest, highest)) * step;
    }
    if (integer) {
      const lowest = Math.ceil(min) +
        (exclusiveMin && Number.isInteger(min) ? 1 : 0);
      const highest = Math.floor(max) -
        (exclusiveMax && Number.isInteger(max) ? 1 : 0);
      return this.int(lowest, Math.max(lowest, highest));
    }
    // A float strictly inside the bounds; integers half of the time, since
    // most numbers in an API are whole.
    if (this.chance(0.5) && Math.ceil(min) + 1 <= Math.floor(max) - 1) {
      return this.int(Math.ceil(min) + 1, Math.floor(max) - 1);
    }
    return min + (max - min) * (0.05 + this.random() * 0.9);
  }

  private date(schema: unknown): Date {
    let min = Date.UTC(2000, 0, 1);
    let max = Date.UTC(2040, 0, 1);
    for (const check of zodChecks(schema)) {
      const value = check.value instanceof Date
        ? check.value.getTime()
        : undefined;
      if (value === undefined) continue;
      if (check.check === "greater_than") min = value + 1;
      if (check.check === "less_than") max = value - 1;
    }
    return new Date(this.int(min, Math.max(min, max)));
  }

  private string(schema: unknown): string {
    let min = 0;
    let max: number | undefined;
    let format: string | undefined;
    let prefix = "";
    let suffix = "";
    let middle = "";
    let upper = false;

    for (const check of zodChecks(schema)) {
      switch (check.check) {
        case "min_length":
          min = Math.max(min, check.minimum as number);
          break;
        case "max_length":
          max = Math.min(max ?? Infinity, check.maximum as number);
          break;
        case "length_equals":
          min = check.length as number;
          max = min;
          break;
        case "string_format":
          switch (check.format) {
            case "starts_with":
              prefix = check.prefix as string;
              break;
            case "ends_with":
              suffix = check.suffix as string;
              break;
            case "includes":
              middle = check.includes as string;
              break;
            case "uppercase":
              upper = true;
              break;
            case "lowercase":
            case "regex":
              // Lowercase is what the generator writes; a regular
              // expression is left to the parse-and-retry loop.
              break;
            default:
              format = check.format as string;
          }
          break;
      }
    }

    const formatted = format === undefined ? undefined : this.format(format);
    if (formatted !== undefined) return formatted;

    const fixed = prefix.length + middle.length + suffix.length;
    const lowest = Math.max(min, fixed);
    const preferred = Math.max(lowest, 3) + 5;
    const highest = Math.max(lowest, Math.min(max ?? preferred, preferred));
    const fill = this.int(lowest, highest) - fixed;
    const head = Math.floor(fill / 2);
    const text = prefix + this.chars(LETTERS, head) + middle +
      this.chars(LETTERS, fill - head) + suffix;
    return upper ? text.toUpperCase() : text;
  }

  /** A string in one of Zod's named formats; `undefined` for the others. */
  private format(format: string): string | undefined {
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    const date = () =>
      `${this.int(2000, 2039)}-${pad(this.int(1, 12))}-${pad(this.int(1, 28))}`;
    const time = () =>
      `${pad(this.int(0, 23))}:${pad(this.int(0, 59))}:${pad(this.int(0, 59))}`;

    switch (format) {
      case "email":
        return `${this.word()}@${this.word()}.example`;
      case "url":
        return `https://${this.word()}.example/${this.word()}`;
      case "uuid":
      case "guid":
        return [
          this.chars(HEX, 8),
          this.chars(HEX, 4),
          "4" + this.chars(HEX, 3),
          this.pick(["8", "9", "a", "b"]) + this.chars(HEX, 3),
          this.chars(HEX, 12),
        ].join("-");
      case "datetime":
        return `${date()}T${time()}Z`;
      case "date":
        return date();
      case "time":
        return time();
      case "ipv4":
        return Array.from({ length: 4 }, () => this.int(1, 254)).join(".");
      case "ipv6":
        return Array.from({ length: 8 }, () => this.chars(HEX, 4)).join(":");
      case "hex":
        return this.chars(HEX, 2 * this.int(1, 8));
      case "base64":
        return btoa(this.word(3, 9));
      case "base64url":
        return btoa(this.word(3, 9)).replace(/=+$/, "").replace(/\+/g, "-")
          .replace(/\//g, "_");
      case "nanoid":
        return this.chars(LETTERS + "0123456789_-", 21);
      case "ulid":
        return this.chars("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26);
      case "cuid":
        return "c" + this.chars(LETTERS + "0123456789", 24);
      case "cuid2":
        return this.chars(LETTERS, 1) +
          this.chars(LETTERS + "0123456789", 23);
      case "e164":
        return "+" + this.int(1, 9) + this.chars("0123456789", 9);
      default:
        return undefined;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    Object.getPrototypeOf(value) === Object.prototype;
}
