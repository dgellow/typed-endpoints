"""What the generated module does with a request, where the suite does not reach.

The conformance tests send requests to the fixture's API on every server.
These are about the generated module by itself: the router in an
application that is not `create_app()`'s, the parts of the runtime the
fixture's schemas do not exercise, and the description FastAPI serves. An
expected answer that is quoted here was measured on the TypeScript handlers
of the fixture.
"""
# A test looks at what the module keeps to itself.
# pyright: reportPrivateUsage=false

import asyncio
import logging
import math
import unittest
from typing import Any

import httpx
from fastapi import FastAPI
from pydantic import TypeAdapter

import api_generated as api
import app

NOTE: dict[str, object] = {"title": "t", "tags": []}


def issues(response: httpx.Response) -> list[tuple[list[str | int], str]]:
    """Where a refused request went wrong, and what was wrong there."""
    return [(issue["path"], issue["message"]) for issue in response.json()["issues"]]


class Client:
    """Sends requests to an application, without a server in between."""

    def __init__(self, application: FastAPI) -> None:
        """Keep the application the requests go to."""
        self.transport = httpx.ASGITransport(app=application)

    def request(self, method: str, path: str, body: object = None) -> httpx.Response:
        """Send one request; a body is sent as JSON."""

        async def send() -> httpx.Response:
            async with httpx.AsyncClient(
                transport=self.transport, base_url="http://test"
            ) as client:
                if body is None:
                    return await client.request(method, path)
                return await client.request(method, path, json=body)

        return asyncio.run(send())

    def get(self, path: str) -> httpx.Response:
        """Send a GET request."""
        return self.request("GET", path)

    def post(self, path: str, body: object) -> httpx.Response:
        """Send a POST request with a JSON body."""
        return self.request("POST", path, body)


class Router(unittest.TestCase):
    """The router in an application of its own."""

    def setUp(self) -> None:
        application = FastAPI()
        application.include_router(api.create_router(app.Notes()), prefix="/v1")
        self.client = Client(application)

    def test_a_refusal_is_the_router_s_own(self) -> None:
        # No handler was installed on the application: FastAPI by itself
        # would answer a 422 in its own shape.
        refused = self.client.post("/v1/api/notes", {"title": "", "tags": "x"})
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            refused.json(),
            {
                "error": "Validation error: title: Too small: expected string to have "
                ">=1 characters, tags: Invalid input: expected array, received string",
                "in": "body",
                "issues": [
                    {
                        "path": ["title"],
                        "message": "Too small: expected string to have >=1 characters",
                        "code": "too_small",
                    },
                    {
                        "path": ["tags"],
                        "message": "Invalid input: expected array, received string",
                        "code": "invalid_type",
                    },
                ],
            },
        )
        created = self.client.post("/v1/api/notes", NOTE)
        self.assertEqual(created.status_code, 200)

    def test_a_malformed_path_is_refused_before_anything_is_read(self) -> None:
        # The body is wrong too: the path is what the answer is about.
        refused = self.client.request("DELETE", "/v1/api/notes/%FF", {"reason": "no"})
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json(), {"error": "Malformed URL path"})

    def test_a_percent_sign_that_starts_no_escape_is_a_malformed_path(self) -> None:
        for path in ("%zz", "%", "a%2"):
            refused = self.client.get(f"/v1/api/notes/{path}")
            self.assertEqual(refused.status_code, 400, path)
            self.assertEqual(refused.json(), {"error": "Malformed URL path"})
        found = self.client.get("/v1/api/echo/a%20b/100%25")
        self.assertEqual(found.json()["path"], "a b/100%")

    def test_a_member_is_read_by_its_name_on_the_wire_only(self) -> None:
        # `class` is `class_` in Python. Sent under that name it is a member
        # the schema does not name, which is dropped.
        shape = {
            "shape": {"kind": "circle", "radius": 1},
            "from": "x",
            "note": None,
        }
        answer = self.client.post(
            "/v1/api/shapes", {**shape, "meta": {"data-id": "m", "class_": "c"}}
        )
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.json()["meta"], {"data-id": "m"})
        # A required one sent under its Python name is missing.
        refused = self.client.post(
            "/v1/api/shapes", {**shape, "meta": {"data_id": "m"}}
        )
        self.assertEqual(
            issues(refused),
            [
                (
                    ["meta", "data-id"],
                    "Invalid input: expected string, received undefined",
                )
            ],
        )

    def test_true_is_not_a_number(self) -> None:
        refused = self.client.post("/v1/api/edges", {"count": True})
        self.assertEqual(
            issues(refused),
            [(["count"], "Invalid input: expected number, received boolean")],
        )

    def test_a_body_nested_deeper_than_the_server_follows_is_refused(self) -> None:
        tree: dict[str, Any] = {"name": "leaf", "children": []}
        for _ in range(400):
            tree = {"name": "node", "children": [tree]}
        refused = self.client.post("/v1/api/trees", tree)
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["in"], "json")

    def test_text_is_read_as_a_number_the_way_javascript_reads_it(self) -> None:
        for limit in ("0x10", "0b11", "1e1", ".5e1", "5.", "%2B5"):
            listed = self.client.get(f"/v1/api/notes?limit={limit}")
            self.assertEqual(listed.status_code, 200, limit)
        not_a_number = "Invalid input: expected number, received NaN"
        for limit in ("abc", "1_0", "%D9%A1", "0x", "-0x1", "infinity"):
            refused = self.client.get(f"/v1/api/notes?limit={limit}")
            self.assertEqual(issues(refused), [(["limit"], not_a_number)], limit)
        # Blank text is 0.
        blank = self.client.get("/v1/api/notes?limit=%20")
        self.assertEqual(
            issues(blank), [(["limit"], "Too small: expected number to be >=1")]
        )

    def test_infinity_is_refused_by_its_name(self) -> None:
        for limit, received in (
            ("Infinity", "Infinity"),
            ("%2BInfinity", "Infinity"),
            ("-Infinity", "-Infinity"),
            ("1e999", "Infinity"),
        ):
            refused = self.client.get(f"/v1/api/notes?limit={limit}")
            message = f"Invalid input: expected number, received {received}"
            self.assertEqual(issues(refused), [(["limit"], message)], limit)

    def test_an_integer_is_one_a_javascript_number_holds_exactly(self) -> None:
        # Said before the bound the schema states, and once where the
        # schema states that bound itself.
        refused = self.client.get("/v1/api/notes?limit=9007199254740993")
        self.assertEqual(
            issues(refused),
            [
                (["limit"], "Too big: expected int to be <=9007199254740991"),
                (["limit"], "Too big: expected number to be <=100"),
            ],
        )
        refused = self.client.post("/v1/api/edges", {"count": -1e300})
        self.assertEqual(
            issues(refused),
            [(["count"], "Too small: expected int to be >=-9007199254740991")],
        )


class Runtime(unittest.TestCase):
    """The parts of the runtime the fixture's schemas do not reach."""

    def test_a_pattern_is_compiled_as_javascript_reads_it(self) -> None:
        compiled = api._pattern
        # `$` is the end of the text, not also before a last line break.
        self.assertTrue(compiled(r"^\d+$").search("12"))
        self.assertFalse(compiled(r"^\d+$").search("12\n"))
        # In a class and escaped it is a dollar.
        self.assertTrue(compiled(r"^[$a]+\$$").search("a$a$"))
        self.assertFalse(compiled(r"^[$a]+\$$").search("a$a"))
        # The classes are ASCII.
        self.assertFalse(compiled(r"^\w+$").search("café"))
        self.assertFalse(compiled(r"^\d$").search("٣"))
        # Compiled once.
        self.assertIs(compiled(r"^\d+$"), compiled(r"^\d+$"))

    def test_a_list_in_a_query(self) -> None:
        schema: dict[str, Any] = {
            "type": "object",
            "properties": {
                "tag": {"type": "array", "items": {"type": "integer"}},
                "flag": {"type": "boolean"},
                "name": {"type": "string"},
            },
            "required": ["tag"],
        }

        def shaped(members: dict[str, object]) -> object:
            return api._from_text(schema, schema, members)

        # One occurrence is a list of one; none, of a list that has to be
        # there, an empty one.
        self.assertEqual(shaped({"tag": "1"}), {"tag": [1]})
        self.assertEqual(shaped({"tag": ["1", "x"]}), {"tag": [1, "x"]})
        self.assertEqual(shaped({}), {"tag": []})
        # Text stays text where the schema asks for text.
        self.assertEqual(
            shaped({"tag": [], "flag": "true", "name": "12", "other": "1"}),
            {"tag": [], "flag": True, "name": "12", "other": "1"},
        )

    def test_a_number_from_text(self) -> None:
        number = api._number_from_text
        self.assertEqual(number(" 12 "), 12)
        self.assertEqual(number(""), 0)
        self.assertEqual(number("0x1F"), 31)
        self.assertEqual(number("0o17"), 15)
        self.assertEqual(number("-2.50"), -2.5)
        # A whole number is an integer, as it is in JavaScript.
        self.assertIsInstance(number("1e3"), int)
        self.assertIsInstance(number("2.0"), int)
        self.assertEqual(number("1e999"), math.inf)
        self.assertEqual(number("-Infinity"), -math.inf)
        for text in ("1,5", "12px", "inf", "nan", "1__0", "0x1.8"):
            self.assertIsNone(number(text), text)

    def test_a_type_that_refuses_what_the_contract_accepts_is_a_500(self) -> None:
        # The two are generated from one contract. If they disagree all the
        # same, the request is not answered as if it were wrong.
        part = api._Part({"type": "string"}, TypeAdapter(int))
        logging.disable(logging.ERROR)
        try:
            with self.assertRaises(api._RefusedError) as raised:
                api._typed("body", part, "text")
        finally:
            logging.disable(logging.NOTSET)
        self.assertEqual(raised.exception.response.status_code, 500)


class Description(unittest.TestCase):
    """What FastAPI's own OpenAPI document says about a request."""

    def setUp(self) -> None:
        self.paths: dict[str, Any] = app.app.openapi()["paths"]

    def test_a_body_is_described_by_the_contract_s_schema(self) -> None:
        body = self.paths["/api/notes"]["post"]["requestBody"]
        self.assertEqual(body["required"], True)
        self.assertEqual(
            body["content"]["application/json"]["schema"],
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 40},
                    "tags": {
                        "maxItems": 4,
                        "type": "array",
                        "items": {"type": "string", "minLength": 1},
                    },
                    "pinned": {"type": "boolean"},
                },
                "required": ["title", "tags"],
            },
        )

    def test_parameters_are_the_members_of_the_path_and_the_query(self) -> None:
        self.assertEqual(
            self.paths["/api/notes/{id}"]["get"]["parameters"],
            [
                {
                    "name": "id",
                    "in": "path",
                    "required": True,
                    "schema": {"type": "string"},
                }
            ],
        )
        query = self.paths["/api/notes"]["get"]["parameters"]
        self.assertEqual(
            [(one["name"], one["in"], one["required"]) for one in query],
            [
                ("cursor", "query", False),
                ("limit", "query", False),
                ("tag", "query", False),
            ],
        )
        self.assertEqual(
            query[1]["schema"],
            {"default": 2, "type": "integer", "minimum": 1, "maximum": 100},
        )

    def test_a_reference_is_written_out_where_it_would_not_resolve(self) -> None:
        # A schema refers to its own document, which is not the one FastAPI
        # serves. One that refers to itself is described down to that.
        tree = self.paths["/api/trees"]["post"]["requestBody"]
        schema = tree["content"]["application/json"]["schema"]
        child = schema["properties"]["children"]["items"]
        self.assertEqual(child["properties"]["name"], {"type": "string"})
        self.assertEqual(
            child["properties"]["children"], {"type": "array", "items": {}}
        )

        odd = self.paths["/api/odd"]["post"]["requestBody"]
        schema = odd["content"]["application/json"]["schema"]
        self.assertNotIn("$defs", schema)
        self.assertNotIn("$ref", str(schema))
        self.assertEqual(schema["properties"]["chain"]["required"], ["name", "origin"])

    def test_a_union_names_the_member_that_decides(self) -> None:
        shapes = self.paths["/api/shapes"]["post"]["requestBody"]
        shape = shapes["content"]["application/json"]["schema"]["properties"]["shape"]
        self.assertEqual(shape["discriminator"], {"propertyName": "kind"})


if __name__ == "__main__":
    unittest.main()
