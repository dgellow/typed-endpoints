/**
 * Compile-time check of the integrations against the frameworks' own types.
 *
 * Not run: type-checked by scripts/check-framework-types, which installs
 * the frameworks at the exact versions listed there. Each assignment below
 * says "what createApiHandlers() returns is a handler of this framework".
 */

import type { APIContext, APIRoute } from "astro";
import type { EventHandler, H3Event } from "h3";
import type { Context, Handler } from "hono";
import type { NextRequest } from "next/server";
import type { RequestEvent, RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

import * as astro from "@dgellow/typed-endpoints/astro";
import * as hono from "@dgellow/typed-endpoints/hono";
import * as next from "@dgellow/typed-endpoints/next";
import * as nitro from "@dgellow/typed-endpoints/nitro";
import * as sveltekit from "@dgellow/typed-endpoints/sveltekit";

const params = z.object({ id: z.string() });

// -----------------------------------------------------------------------------
// Next.js: (request: NextRequest, context: { params: Promise<...> })
// -----------------------------------------------------------------------------

type NextRouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Response | Promise<Response>;

const nextHandlers = next.createApiHandlers({
  GET: next.endpoint({
    params,
    handler: (_request, v) => Response.json(v.params),
  }),
});
export const nextGet: NextRouteHandler = nextHandlers.GET;

// With the app's request type, the handler sees NextRequest's members.
const nextTyped = next.withRequest<NextRequest>();
export const nextTypedGet: NextRouteHandler = nextTyped.createApiHandlers({
  GET: nextTyped.endpoint({
    handler: (request) => Response.json({ path: request.nextUrl.pathname }),
  }),
}).GET;

// -----------------------------------------------------------------------------
// SvelteKit: RequestHandler = (event: RequestEvent) => Response
// -----------------------------------------------------------------------------

export const svelteGet: RequestHandler = sveltekit.createApiHandlers({
  GET: sveltekit.endpoint({
    params,
    handler: (_event, v) => Response.json(v.params),
  }),
}).GET;

const svelteTyped = sveltekit.withEvent<RequestEvent>();
export const svelteTypedGet: RequestHandler = svelteTyped.createApiHandlers({
  GET: svelteTyped.endpoint({
    handler: (event) => Response.json({ route: event.route.id }),
  }),
}).GET;

// -----------------------------------------------------------------------------
// Astro: APIRoute = (context: APIContext) => Response
// -----------------------------------------------------------------------------

export const astroGet: APIRoute = astro.createApiHandlers({
  GET: astro.endpoint({
    params,
    handler: (_context, v) => Response.json(v.params),
  }),
}).GET;

const astroTyped = astro.withContext<APIContext>();
export const astroTypedGet: APIRoute = astroTyped.createApiHandlers({
  GET: astroTyped.endpoint({
    handler: (context) => Response.json({ site: String(context.site) }),
  }),
}).GET;

// -----------------------------------------------------------------------------
// Hono: Handler = (c: Context) => Response
// -----------------------------------------------------------------------------

export const honoGet: Handler = hono.createApiHandlers({
  GET: hono.endpoint({
    params,
    handler: (_c, v) => Response.json(v.params),
  }),
}).GET;

const honoTyped = hono.withContext<Context>();
export const honoTypedGet: Handler = honoTyped.createApiHandlers({
  GET: honoTyped.endpoint({
    handler: (c) => c.json({ path: c.req.path }),
  }),
}).GET;

// -----------------------------------------------------------------------------
// h3 v2: EventHandler = (event: H3Event) => unknown
// -----------------------------------------------------------------------------

export const h3Get: EventHandler = nitro.createApiHandlers({
  GET: nitro.endpoint({
    params,
    handler: (_event, v) => Response.json(v.params),
  }),
}).GET;

export const h3Default: EventHandler = nitro.createHandler(nitro.endpoint({
  params,
  handler: (_event, v) => Response.json(v.params),
}));

const h3Typed = nitro.withEvent<H3Event>();
export const h3TypedGet: EventHandler = h3Typed.createApiHandlers({
  GET: h3Typed.endpoint({
    handler: (event) => Response.json({ path: event.url.pathname }),
  }),
}).GET;
