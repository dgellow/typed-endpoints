"""The generated Python client against a server of the fixture API.

Run by `./scripts/test-python` twice: with `API_URL` set to the fixture's
TypeScript handlers, and to the generated FastAPI application. The tests
are the Python counterpart of `conformance.ts`: the same contract, read by
a client in another language.
"""

import asyncio
import os
import unittest
import uuid
from typing import Any, cast

import client_generated as api

API_URL = os.environ["API_URL"]


def unique(prefix: str) -> str:
    """Make a name no other test, run or server-side note uses."""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = api.Client(API_URL)

    def tearDown(self) -> None:
        self.client.close()

    def test_create_retrieve_and_replace(self) -> None:
        created = self.client.notes_create(
            api.NotesCreateBody(title=unique("first"), tags=["a", "b"])
        )
        self.assertEqual(created.likes, 0)
        self.assertEqual(created.tags, ["a", "b"])
        # A field that was not sent is not in the answer.
        self.assertNotIn("pinned", created.model_fields_set)

        self.assertEqual(self.client.notes_retrieve(created.id), created)

        replaced = self.client.notes_update(
            created.id, api.NotesUpdateBody(title="renamed", tags=[], pinned=True)
        )
        self.assertEqual(
            replaced.model_dump(),
            {
                "id": created.id,
                "likes": 0,
                "title": "renamed",
                "tags": [],
                "pinned": True,
            },
        )

    def test_a_declared_error_is_a_value(self) -> None:
        missing = self.client.notes_retrieve_result("no-such-note")
        assert isinstance(missing, api.Fail)
        self.assertEqual(missing.status, 404)
        self.assertEqual(
            missing.body, api.NotFound(error="not_found", id="no-such-note")
        )

        title = unique("taken")
        first = self.client.notes_create_result(
            api.NotesCreateBody(title=title, tags=[])
        )
        assert not isinstance(first, api.Fail)
        again = self.client.notes_create_result(
            api.NotesCreateBody(title=title, tags=[])
        )
        assert isinstance(again, api.Fail)
        self.assertEqual(again.status, 409)
        self.assertEqual(again.body.title, title)

    def test_a_plain_call_raises_for_the_same_answer(self) -> None:
        with self.assertRaises(api.ApiError) as raised:
            self.client.notes_retrieve("no-such-note")
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(
            raised.exception.body, {"error": "not_found", "id": "no-such-note"}
        )

    def test_a_status_that_is_not_declared_raises_from_result_too(self) -> None:
        # A reason shorter than the schema allows: a 400, which the DELETE
        # does not declare. The body model is built unchecked to send it.
        note = unique("d")
        self.client.notes_update(note, api.NotesUpdateBody(title="x", tags=[]))
        with self.assertRaises(api.ApiError) as raised:
            self.client.notes_delete_result(
                note, api.NotesDeleteBody.model_construct(reason="no")
            )
        self.assertEqual(raised.exception.status, 400)
        body = cast("dict[str, Any]", raised.exception.body)
        self.assertEqual(body["in"], "body")
        self.assertEqual([issue["path"] for issue in body["issues"]], [["reason"]])

    def test_pages_and_items_follow_the_cursor(self) -> None:
        tag = unique("listed")
        for name in ("l1", "l2", "l3", "l4", "l5"):
            self.client.notes_update(
                f"{tag}-{name}",
                api.NotesUpdateBody(
                    title=name, tags=[tag, "odd"] if name == "l3" else [tag]
                ),
            )

        # Pages of two (the server's default), until there is no cursor.
        pages = [
            [item.title for item in page.items]
            for page in self.client.notes_list_pages(api.NotesListQuery(tag=[tag]))
        ]
        self.assertEqual(pages, [["l1", "l2"], ["l3", "l4"], ["l5"]])

        titles = [
            item.title
            for item in self.client.notes_list_items(
                api.NotesListQuery(tag=[tag], limit=4)
            )
        ]
        self.assertEqual(titles, ["l1", "l2", "l3", "l4", "l5"])

        # Every given tag has to be on the note; the last page has no cursor.
        odd = self.client.notes_list(api.NotesListQuery(tag=[tag, "odd"]))
        self.assertEqual([item.title for item in odd.items], ["l3"])
        self.assertNotIn("cursor", odd.model_fields_set)

    def test_a_delete_carries_a_body(self) -> None:
        note = unique("d")
        self.client.notes_update(note, api.NotesUpdateBody(title="x", tags=[]))
        deleted = self.client.notes_delete(note, api.NotesDeleteBody(reason="obsolete"))
        self.assertEqual(deleted.model_dump(), {"deleted": True, "reason": "obsolete"})

        gone = self.client.notes_delete_result(
            note, api.NotesDeleteBody(reason="obsolete")
        )
        assert isinstance(gone, api.Fail)
        self.assertEqual(gone.status, 404)

    def test_a_catch_all_parameter_keeps_its_slashes(self) -> None:
        echoed = self.client.echo_retrieve("docs/guide/intro file.md")
        self.assertEqual(echoed.path, "docs/guide/intro file.md")
        self.assertEqual(echoed.segments, ["docs", "guide", "intro file.md"])

    def test_unions_aliases_defaults_and_nulls(self) -> None:
        circle = self.client.shapes_create(
            api.ShapesCreateBody(
                shape=api.ShapesCreateBodyShapeCircle(kind="circle", radius=2),
                from_="sketch",
                meta=api.ShapesCreateBodyMeta(data_id="m1"),
                note=None,
            )
        )
        self.assertEqual(
            circle.model_dump(by_alias=True, exclude_unset=True),
            {
                "area": 12,
                "kind": "circle",
                "from": "sketch",
                "meta": {"data-id": "m1"},
                "unit": "mm",
                "note": None,
            },
        )

    def test_a_schema_that_refers_to_itself(self) -> None:
        def leaf(name: str) -> api.TreesCreateBody:
            return api.TreesCreateBody(name=name, children=[])

        root = api.TreesCreateBody(
            name="root",
            children=[leaf("a"), api.TreesCreateBody(name="b", children=[leaf("c")])],
        )
        answer = self.client.trees_create(root)
        self.assertEqual(answer.depth, 3)
        self.assertEqual(answer.root.model_dump(), root.model_dump())

    def test_shapes_python_has_to_find_a_way_to_say(self) -> None:
        link = api.OddCreateBodyChain
        odd = api.OddCreateBody(
            type_="memo",
            created_at="2026-11-14",
            created_at_2="2026-11-13",
            field_2fa=True,
            pair=("width", 2.5),
            scores={"first": 1, "second": 2},
            loose=["a", "b"],
            loose_or_null=None,
            version=2,
            level="very-high",
            anything={"nested": [1, "two", None]},
            chain=link(name="a", origin=None, next=link(name="b", origin=None)),
            json_={"list": [1, "two", None, {"deep": [True]}]},
            expr=api.OddCreateBodyExpr3(
                op="add", args=[1, api.OddCreateBodyExpr2(op="neg", of=2)]
            ),
        )
        answer = self.client.odd_create(odd)
        sent = odd.model_dump(by_alias=True, exclude_unset=True)
        self.assertEqual(
            answer.model_dump(by_alias=True, exclude_unset=True),
            {**sent, "limit": None},
        )
        self.assertEqual(answer.pair, ("width", 2.5))
        self.assertIsNotNone(answer.chain.next)


class AsyncClientTest(unittest.TestCase):
    def test_the_async_client_does_the_same(self) -> None:
        async def run() -> None:
            client = api.AsyncClient(API_URL)
            try:
                tag = unique("async")
                for name in ("a1", "a2", "a3"):
                    await client.notes_update(
                        f"{tag}-{name}", api.NotesUpdateBody(title=name, tags=[tag])
                    )
                titles = [
                    item.title
                    async for item in client.notes_list_items(
                        api.NotesListQuery(tag=[tag])
                    )
                ]
                self.assertEqual(titles, ["a1", "a2", "a3"])

                missing = await client.notes_retrieve_result("no-such-note")
                assert isinstance(missing, api.Fail)
                self.assertEqual(missing.status, 404)

                with self.assertRaises(api.ApiError):
                    await client.notes_retrieve("no-such-note")
            finally:
                await client.aclose()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
