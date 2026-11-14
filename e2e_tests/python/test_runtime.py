"""What the generated module does with what a handler returns.

The conformance tests cover handlers that keep to their types. These cover
handlers that do not: the generated router answers 500 and logs, and never
sends a body the operation does not declare.
"""

import asyncio
import json
import logging
import unittest
from typing import Any

from fastapi.responses import Response
from pydantic import TypeAdapter

import api_generated as api
import app

NOTE: TypeAdapter[Any] = TypeAdapter(api.Note)
ERRORS: dict[int, TypeAdapter[Any]] = {404: TypeAdapter(api.NotFound)}


async def _value(value: object) -> object:
    return value


def respond(
    value: object,
    response: TypeAdapter[Any] | None = NOTE,
    errors: dict[int, TypeAdapter[Any]] = ERRORS,
) -> tuple[int, Any]:
    """Status and body of what the router answers for a handler's result."""
    sent = asyncio.run(
        api._respond("GET /test", _value(value), response, errors)  # pyright: ignore[reportPrivateUsage]
    )
    body = bytes(sent.body)
    return sent.status_code, json.loads(body) if body else None


class Respond(unittest.TestCase):
    def setUp(self) -> None:
        logging.disable(logging.ERROR)

    def tearDown(self) -> None:
        logging.disable(logging.NOTSET)

    def test_a_value_is_parsed_by_the_response_model(self) -> None:
        note = {"id": "1", "likes": 0, "title": "t", "tags": ["a"]}
        self.assertEqual(respond(note), (200, note))
        # A model instance is sent without the fields that were not set.
        self.assertEqual(respond(api.Note.model_validate(note)), (200, note))

    def test_none_is_a_member_left_out_unless_null_is_a_value_of_it(self) -> None:
        note: dict[str, object] = {"id": "1", "likes": 0, "title": "t", "tags": []}
        # `pinned` may be left out and is never null: None says "left out",
        # also when it was passed, and nothing is written.
        self.assertEqual(
            respond(api.Note(id="1", likes=0, title="t", tags=[], pinned=None)),
            (200, note),
        )
        # `maybe` may be left out or be null: set to None it is null, and not
        # set it is left out.
        edges: TypeAdapter[Any] = TypeAdapter(api.EdgesCreateResponse)
        self.assertEqual(
            respond(api.EdgesCreateResponse(received=[], maybe=None), edges),
            (200, {"received": [], "maybe": None}),
        )
        self.assertEqual(
            respond(api.EdgesCreateResponse(received=[], count=None), edges),
            (200, {"received": []}),
        )

    def test_a_value_the_model_rejects_is_a_500(self) -> None:
        rejected: list[Any] = [
            {"id": "1", "likes": 0, "title": "", "tags": []},
            {"id": "1", "likes": "0", "title": "t", "tags": []},
            None,
        ]
        for wrong in rejected:
            self.assertEqual(respond(wrong), (500, {"error": "Internal Server Error"}))

    def test_a_member_the_response_does_not_name_is_not_sent(self) -> None:
        # Dropped, as the TypeScript handlers drop it: not a 500.
        note: dict[str, object] = {"id": "1", "likes": 0, "title": "t", "tags": []}
        self.assertEqual(respond({**note, "secret": "x"}), (200, note))

    def test_a_model_instance_is_checked_again(self) -> None:
        # Pydantic trusts an instance. One built unchecked, or changed
        # after it was built, is not what its model describes.
        unchecked = api.Note.model_construct(id="1", likes=0, title="", tags=[])
        self.assertEqual(respond(unchecked), (500, {"error": "Internal Server Error"}))

        changed = api.Note(id="1", likes=0, title="t", tags=[])
        changed.title = ""
        self.assertEqual(respond(changed), (500, {"error": "Internal Server Error"}))

        failure = api.NotFound.model_construct(error="gone", id="1")
        self.assertEqual(
            respond(api.Fail(404, failure)), (500, {"error": "Internal Server Error"})
        )

    def test_a_declared_failure_is_sent_with_its_status(self) -> None:
        body = {"error": "not_found", "id": "1"}
        self.assertEqual(respond(api.Fail(404, body)), (404, body))
        self.assertEqual(
            respond(api.Fail(404, api.NotFound(error="not_found", id="1"))),
            (404, body),
        )

    def test_a_failure_the_operation_does_not_declare_is_a_500(self) -> None:
        body = {"error": "not_found", "id": "1"}
        self.assertEqual(
            respond(api.Fail(410, body)), (500, {"error": "Internal Server Error"})
        )
        # A declared status with a body its model rejects.
        self.assertEqual(
            respond(api.Fail(404, {"error": "gone"})),
            (500, {"error": "Internal Server Error"}),
        )

    def test_a_response_is_sent_as_it_is(self) -> None:
        status, body = respond(Response(content=b'{"raw": true}', status_code=202))
        self.assertEqual((status, body), (202, {"raw": True}))

    def test_without_a_response_model(self) -> None:
        self.assertEqual(respond(None, response=None), (204, None))
        self.assertEqual(respond({"any": 1}, response=None), (200, {"any": 1}))


class Description(unittest.TestCase):
    """What FastAPI's own OpenAPI document says about the application."""

    def setUp(self) -> None:
        self.paths: dict[str, Any] = app.app.openapi()["paths"]

    def schema(self, path: str, method: str, status: str) -> dict[str, Any]:
        response = self.paths[path][method]["responses"][status]
        return response["content"]["application/json"]["schema"]

    def test_an_operation_lists_what_it_answers(self) -> None:
        retrieve = self.paths["/api/notes/{id}"]["get"]["responses"]
        # The success, the 400 of a failed validation, the declared error;
        # not the 422 FastAPI would send by itself, which is never sent.
        self.assertEqual(sorted(retrieve), ["200", "400", "404"])
        self.assertEqual(
            self.schema("/api/notes/{id}", "get", "404"),
            {"$ref": "#/components/schemas/NotFound"},
        )
        self.assertEqual(
            self.schema("/api/notes/{id}", "get", "400"),
            {"$ref": "#/components/schemas/InvalidRequest"},
        )
        self.assertIn("$ref", self.schema("/api/notes/{id}", "get", "200"))
        # With a body: also the 415 of one that does not claim to be JSON.
        self.assertEqual(
            sorted(self.paths["/api/notes"]["post"]["responses"]),
            ["200", "400", "409", "415"],
        )

    def test_no_operation_documents_a_422(self) -> None:
        for path in self.paths.values():
            for operation in path.values():
                self.assertNotIn("422", operation["responses"])


if __name__ == "__main__":
    unittest.main()
