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

NOTE: TypeAdapter[Any] = TypeAdapter(api.NotesRetrieveResponse)
ERRORS: dict[int, TypeAdapter[Any]] = {404: TypeAdapter(api.NotFound)}


async def _value(value: Any) -> Any:
    return value


def respond(
    value: Any,
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
        self.assertEqual(
            respond(api.NotesRetrieveResponse.model_validate(note)), (200, note)
        )

    def test_a_value_the_model_rejects_is_a_500(self) -> None:
        rejected: list[Any] = [
            {"id": "1", "likes": 0, "title": "", "tags": []},
            {"id": "1", "likes": "0", "title": "t", "tags": []},
            {"id": "1", "likes": 0, "title": "t", "tags": [], "secret": "x"},
            None,
        ]
        for wrong in rejected:
            self.assertEqual(
                respond(wrong), (500, {"error": "Internal Server Error"})
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


if __name__ == "__main__":
    unittest.main()
