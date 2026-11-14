import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { filePathToOpenApiPath, generateOpenApiSpec } from "./openapi.ts";

// filePathToOpenApiPath tests

Deno.test("filePathToOpenApiPath basic conversion", () => {
  assertEquals(filePathToOpenApiPath("routes/api/users.ts"), "/api/users");
});

Deno.test("filePathToOpenApiPath handles .tsx extension", () => {
  assertEquals(filePathToOpenApiPath("routes/api/users.tsx"), "/api/users");
});

Deno.test("filePathToOpenApiPath handles [param]", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles [...param] (catch-all)", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/files/[...path].ts"),
    "/api/files/{path}",
  );
});

Deno.test("filePathToOpenApiPath handles index files", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/index.ts"),
    "/api/users",
  );
});

Deno.test("filePathToOpenApiPath handles root index", () => {
  assertEquals(filePathToOpenApiPath("routes/index.ts"), "/");
});

Deno.test("filePathToOpenApiPath handles route groups", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/login.ts"),
    "/api/login",
  );
});

Deno.test("filePathToOpenApiPath handles nested route groups", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/(admin)/settings.ts"),
    "/api/settings",
  );
});

Deno.test("filePathToOpenApiPath handles route group with params", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/users/[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles Windows backslashes", () => {
  assertEquals(
    filePathToOpenApiPath("routes\\api\\users\\[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles mixed slashes", () => {
  assertEquals(
    filePathToOpenApiPath("routes\\api/users\\[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles multiple params", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/[userId]/posts/[postId].ts"),
    "/api/users/{userId}/posts/{postId}",
  );
});

Deno.test("filePathToOpenApiPath handles deeply nested routes", () => {
  assertEquals(
    filePathToOpenApiPath(
      "routes/api/v1/organizations/[orgId]/teams/[teamId]/members.ts",
    ),
    "/api/v1/organizations/{orgId}/teams/{teamId}/members",
  );
});

Deno.test("filePathToOpenApiPath strips route groups but keeps structure", () => {
  assertEquals(
    filePathToOpenApiPath("routes/(marketing)/blog/posts/[slug].ts"),
    "/blog/posts/{slug}",
  );
});

Deno.test("filePathToOpenApiPath ignores what precedes the routes directory", () => {
  for (
    const prefix of ["", "./", "src/", "/home/me/project/", "C:\\project\\"]
  ) {
    assertEquals(
      filePathToOpenApiPath(`${prefix}routes/api/users/[id].ts`),
      "/api/users/{id}",
      prefix,
    );
  }
});

// =============================================================================
// generateOpenApiSpec
// =============================================================================

const FIXTURES_DIR = new URL("./fixtures/routes/api", import.meta.url).pathname;

/** Run `fn` with console.warn captured instead of printed. */
async function captureWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("generateOpenApiSpec emits operationIds and URL paths", async () => {
  const { result: spec, warnings } = await captureWarnings(() =>
    generateOpenApiSpec({ routesDir: FIXTURES_DIR })
  );

  // The routes directory is an absolute path; the spec paths are URL paths.
  assertEquals(Object.keys(spec.paths ?? {}).sort(), [
    "/api/items",
    "/api/items/{id}",
    "/api/items/{id}/copy",
  ]);

  const items = spec.paths!["/api/items"];
  const item = spec.paths!["/api/items/{id}"];
  const copy = spec.paths!["/api/items/{id}/copy"];
  // Derived: the same id that `--format routes` uses as the route key.
  assertEquals(items.get?.operationId, "itemsList");
  assertEquals(item.get?.operationId, "itemsRetrieve");
  // Explicit operationId wins.
  assertEquals(items.post?.operationId, "createItem");
  // PUT next to PATCH: "replace" and "update".
  assertEquals(item.put?.operationId, "itemsReplace");
  assertEquals(item.patch?.operationId, "itemsUpdate");
  // Not public.
  assertEquals(item.delete, undefined);
  // A duplicate operationId makes the spec invalid, so neither gets one.
  assertEquals(copy.post?.operationId, undefined);
  assertEquals(copy.put?.operationId, undefined);

  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings.join("\n"), "broken.ts");
  assertStringIncludes(warnings.join("\n"), 'operationId "duplicateItem"');
});

Deno.test("generateOpenApiSpec strict mode reports every problem", async () => {
  const error = await assertRejects(
    () => generateOpenApiSpec({ routesDir: FIXTURES_DIR, strict: true }),
    Error,
    "OpenAPI generation failed",
  );
  assertStringIncludes(error.message, "broken.ts: route module failed to load");
  assertStringIncludes(
    error.message,
    'operationId "duplicateItem" is used by POST /api/items/{id}/copy',
  );
  assertStringIncludes(error.message, "and PUT /api/items/{id}/copy");
});

// =============================================================================
// generateOpenApiSpec: what an operation carries
// =============================================================================

const DESCRIBED_DIR =
  new URL("./fixtures/described/routes/api", import.meta.url).pathname;

Deno.test("generateOpenApiSpec passes info and servers through", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
    info: { title: "Reports", version: "2.1.0", description: "Internal" },
    servers: [{ url: "https://api.example.test", "x-env": "prod" }],
  });

  assertEquals(spec.openapi, "3.1.0");
  assertEquals(spec.info, {
    title: "Reports",
    version: "2.1.0",
    description: "Internal",
  });
  assertEquals(spec.servers, [
    { url: "https://api.example.test", "x-env": "prod" },
  ]);
});

Deno.test("generateOpenApiSpec defaults: title, version, no servers", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });

  assertEquals(spec.info.title, "API");
  assertEquals(spec.info.version, "1.0.0");
  assertEquals(spec.servers, undefined);
});

Deno.test("generateOpenApiSpec leaves out route files without typed handlers", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });

  assertEquals(Object.keys(spec.paths ?? {}).sort(), [
    "/api/reports",
    "/api/reports/{id}",
  ]);
});

Deno.test("generateOpenApiSpec describes query parameters, metadata and pagination", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });
  // deno-lint-ignore no-explicit-any
  const list = spec.paths!["/api/reports"].get as any;

  assertEquals(list.summary, "List reports");
  assertEquals(list.description, "Reports, newest first.");
  assertEquals(list.tags, ["reports"]);
  assertEquals(list["x-pagination"], {
    style: "cursor",
    items: "data",
    cursor: "next",
    cursorParam: "cursor",
    limitParam: "limit",
  });
  assertEquals(list.parameters, [
    {
      name: "cursor",
      in: "query",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
    {
      name: "tag",
      in: "query",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ]);
  assertEquals(
    Object.keys(
      list.responses["200"].content["application/json"].schema.properties,
    ),
    ["data", "next"],
  );
});

Deno.test("generateOpenApiSpec registers named bodies and responses as components", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });
  // deno-lint-ignore no-explicit-any
  const create = spec.paths!["/api/reports"].post as any;

  assertEquals(Object.keys(spec.components?.schemas ?? {}).sort(), [
    "NewReport",
    "Report",
    "ValidationProblem",
  ]);
  assertEquals(create.requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/NewReport",
  });
  assertEquals(create.responses["200"].content["application/json"].schema, {
    $ref: "#/components/schemas/Report",
  });
  // A bare schema under `responses` is inlined.
  assertEquals(create.responses["409"], {
    description: "Response 409",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },
  });
  // `{ schema, name }` is a component.
  assertEquals(create.responses["422"].content["application/json"].schema, {
    $ref: "#/components/schemas/ValidationProblem",
  });
});

Deno.test("generateOpenApiSpec derives path parameters and omits a body outside POST, PUT, PATCH", async () => {
  const spec = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });
  // deno-lint-ignore no-explicit-any
  const item = spec.paths!["/api/reports/{id}"] as any;
  const idParam = [{
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  }];

  // No `params` schema: the parameter comes from the file name.
  assertEquals(item.delete.parameters, idParam);
  // No response schema: a 200 without content.
  assertEquals(item.delete.responses, { "200": { description: "Success" } });

  assertEquals(item.get.parameters, idParam);
  assertEquals(item.get.requestBody, undefined);
  // `responses: { 200 }` stands in for `response`.
  assertEquals(
    item.get.responses["200"].content["application/json"].schema.required,
    ["id"],
  );
});

Deno.test("generateOpenApiSpec can run twice over routes with named components", async () => {
  const first = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });
  const second = await generateOpenApiSpec({
    routesDir: DESCRIBED_DIR,
    strict: true,
  });

  assertEquals(second, first);
});
