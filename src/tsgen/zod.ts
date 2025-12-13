import type { ZodType } from "zod";

/**
 * Convert a Zod schema to a TypeScript type string.
 * Custom implementation for Zod v4 that doesn't require TypeScript compiler.
 */
export function zodToTypeString(schema: ZodType): string {
  return convert(schema);
}

/** Get the internal def object from a Zod schema (works with v3 and v4) */
function getDef(schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  const zod = s._zod as Record<string, unknown> | undefined;
  return (zod?.def ?? s._def ?? {}) as Record<string, unknown>;
}

/** Get the type name from a def object */
function getTypeName(def: Record<string, unknown>): string {
  return (def.type ?? def.typeName ?? "unknown") as string;
}

function convert(schema: unknown): string {
  const def = getDef(schema);
  const typeName = getTypeName(def);

  switch (typeName) {
    // Primitives
    case "string":
      return "string";
    case "number":
    case "int":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "date":
      return "Date";
    case "symbol":
      return "symbol";

    // Special types
    case "any":
      return "any";
    case "unknown":
      return "unknown";
    case "never":
      return "never";
    case "void":
      return "void";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "nan":
      return "number";
    case "file":
      return "File";

    // Literal
    case "literal": {
      const values = def.values as unknown[];
      return values
        .map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
        .join(" | ");
    }

    // Enum
    case "enum": {
      const entries = def.entries as Record<string, string | number>;
      const values = Object.values(entries);
      return values
        .map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
        .join(" | ");
    }

    // Array
    case "array": {
      const inner = convert(def.element);
      if (inner.includes("|") && !inner.startsWith("(")) {
        return `(${inner})[]`;
      }
      return `${inner}[]`;
    }

    // Object
    case "object": {
      const shape = def.shape as Record<string, unknown>;
      const entries = Object.entries(shape);
      if (entries.length === 0) {
        return "{}";
      }
      const props = entries.map(([key, value]) => {
        const isOptional = getTypeName(getDef(value)) === "optional";
        const typeStr = convert(value);
        const optionalMark = isOptional ? "?" : "";
        return `${key}${optionalMark}: ${typeStr}`;
      });
      return `{ ${props.join("; ")}; }`;
    }

    // Optional
    case "optional": {
      const inner = convert(def.innerType);
      return `${inner} | undefined`;
    }

    // Nullable
    case "nullable": {
      const inner = convert(def.innerType);
      return `${inner} | null`;
    }

    // Union
    case "union": {
      const options = def.options as unknown[];
      return options.map(convert).join(" | ");
    }

    // Intersection
    case "intersection": {
      const left = convert(def.left);
      const right = convert(def.right);
      return `${left} & ${right}`;
    }

    // Tuple
    case "tuple": {
      const items = def.items as unknown[];
      const itemTypes = items.map(convert);
      if (def.rest) {
        return `[${itemTypes.join(", ")}, ...${convert(def.rest)}[]]`;
      }
      return `[${itemTypes.join(", ")}]`;
    }

    // Record
    case "record": {
      const keyType = def.keyType ? convert(def.keyType) : "string";
      const valueType = convert(def.valueType);
      return `Record<${keyType}, ${valueType}>`;
    }

    // Map
    case "map": {
      const keyType = convert(def.keyType);
      const valueType = convert(def.valueType);
      return `Map<${keyType}, ${valueType}>`;
    }

    // Set
    case "set": {
      const valueType = convert(def.valueType);
      return `Set<${valueType}>`;
    }

    // Promise
    case "promise": {
      const inner = convert(def.innerType);
      return `Promise<${inner}>`;
    }

    // Function
    case "function": {
      const inputType = def.input ? convert(def.input) : "[]";
      const outputType = def.output ? convert(def.output) : "void";
      return `(...args: ${inputType}) => ${outputType}`;
    }

    // Lazy (recursive types)
    case "lazy": {
      const getter = def.getter as () => unknown;
      return convert(getter());
    }

    // Wrappers that pass through to inner type
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "success":
      return convert(def.innerType);

    // Transform
    case "transform":
      return "unknown";

    // Pipe (schema chaining)
    case "pipe":
      return convert(def.out);

    // Custom validators
    case "custom":
      return "unknown";

    // Template literals
    case "template_literal":
      return "string";

    default:
      return "unknown";
  }
}
