"""Where the next page is, for every pagination style.

The fixture API pages by cursor, which `test_client.py` follows over HTTP.
The other styles are checked here against the rule the generated client
carries, which is the rule of the TypeScript client (`nextPage()` in
`src/client/index.ts`).
"""

import unittest
from typing import Any, ClassVar

import client_generated as api


def step(
    meta: dict[str, Any],
    page: object,
    query: dict[str, Any] | None = None,
    page_size: int = 2,
) -> object:
    """Ask the generated client where the page after `page` is."""
    return api._next_page("list", meta, page, query or {}, page_size)  # pyright: ignore[reportPrivateUsage]


class Cursor(unittest.TestCase):
    META: ClassVar[dict[str, Any]] = {
        "style": "cursor",
        "items": "items",
        "cursor": "next",
        "cursorParam": "after",
    }

    def test_the_cursor_of_the_page_is_asked_for_next(self) -> None:
        self.assertEqual(
            step(self.META, {"items": [1], "next": "c2"}, {"limit": 1}),
            ("query", {"limit": 1, "after": "c2"}),
        )

    def test_no_cursor_is_the_end(self) -> None:
        for page in (
            {"items": [1]},
            {"items": [1], "next": None},
            {"items": [1], "next": ""},
        ):
            self.assertIsNone(step(self.META, page))

    def test_the_cursor_that_was_asked_for_is_refused(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "there is no next page"):
            step(self.META, {"items": [1], "next": "c1"}, {"after": "c1"})

    def test_a_nested_cursor(self) -> None:
        meta = {**self.META, "items": "data.items", "cursor": "data.next"}
        self.assertEqual(
            step(meta, {"data": {"items": [1], "next": "c2"}}),
            ("query", {"after": "c2"}),
        )


class CursorId(unittest.TestCase):
    META: ClassVar[dict[str, Any]] = {
        "style": "cursorId",
        "items": "items",
        "cursorIdParam": "after",
        "idField": "id",
        "limitParam": "limit",
    }

    def test_the_id_of_the_last_item_is_asked_for_next(self) -> None:
        page = {"items": [{"id": 7}, {"id": 9}]}
        self.assertEqual(
            step(self.META, page, {"limit": 2}), ("query", {"limit": 2, "after": "9"})
        )

    def test_an_empty_or_short_page_is_the_end(self) -> None:
        self.assertIsNone(step(self.META, {"items": []}))
        self.assertIsNone(step(self.META, {"items": [{"id": 1}]}, {"limit": 2}))

    def test_an_item_without_the_id_field(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'has no "id"'):
            step(self.META, {"items": [{"name": "x"}]})

    def test_the_item_that_was_asked_for_is_refused(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "there is no next page"):
            step(self.META, {"items": [{"id": 9}]}, {"after": "9"})


class Offset(unittest.TestCase):
    META: ClassVar[dict[str, Any]] = {
        "style": "offset",
        "items": "items",
        "total": "total",
        "offsetParam": "offset",
        "limitParam": "limit",
    }

    def test_the_offset_moves_by_the_items_received(self) -> None:
        self.assertEqual(
            step(self.META, {"items": [1, 2], "total": 5}), ("query", {"offset": 2})
        )
        self.assertEqual(
            step(self.META, {"items": [3, 4], "total": 5}, {"offset": 2}),
            ("query", {"offset": 4}),
        )

    def test_the_total_or_an_empty_page_is_the_end(self) -> None:
        self.assertIsNone(step(self.META, {"items": [5], "total": 5}, {"offset": 4}))
        self.assertIsNone(step(self.META, {"items": [], "total": 5}, {"offset": 9}))


class Page(unittest.TestCase):
    META: ClassVar[dict[str, Any]] = {
        "style": "page",
        "items": "items",
        "total": "total",
        "totalPages": "pages",
        "pageParam": "page",
        "perPageParam": "perPage",
    }

    def test_the_next_page_number(self) -> None:
        self.assertEqual(step(self.META, {"items": [1, 2]}), ("query", {"page": 2}))
        self.assertEqual(
            step(self.META, {"items": [3, 4]}, {"page": 2, "perPage": 2}),
            ("query", {"page": 3, "perPage": 2}),
        )

    def test_where_it_ends(self) -> None:
        # The number of pages, the total, a short page, an empty page.
        self.assertIsNone(step(self.META, {"items": [1, 2], "pages": 1}))
        self.assertIsNone(step(self.META, {"items": [3, 4], "total": 4}, {"page": 2}))
        self.assertIsNone(step(self.META, {"items": [1]}))
        self.assertIsNone(step(self.META, {"items": []}, {"page": 3}))
        # Also the first page, when nothing else says so: no size is known.
        bare = {"style": "page", "items": "items", "pageParam": "page"}
        self.assertIsNone(step(bare, {"items": []}, page_size=0))

    def test_the_first_page_gives_the_size_when_the_query_does_not(self) -> None:
        self.assertEqual(
            step(self.META, {"items": [1, 2, 3]}, page_size=3), ("query", {"page": 2})
        )
        self.assertIsNone(step(self.META, {"items": [1, 2]}, page_size=3))


class Url(unittest.TestCase):
    META: ClassVar[dict[str, Any]] = {
        "style": "url",
        "items": "items",
        "nextUrl": "links.next",
    }

    def test_the_url_of_the_page(self) -> None:
        self.assertEqual(
            step(self.META, {"items": [1], "links": {"next": "/items?page=2"}}),
            ("url", "/items?page=2"),
        )
        self.assertIsNone(step(self.META, {"items": [1], "links": {}}))

    def test_a_next_page_on_another_origin_is_not_followed(self) -> None:
        same = api._same_origin  # pyright: ignore[reportPrivateUsage]
        base = "http://api.example.test/v1"
        self.assertEqual(
            same("list", base, "/v1/items?page=2"),
            "http://api.example.test/v1/items?page=2",
        )
        self.assertEqual(
            same("list", base, "http://api.example.test/v1/items?page=2"),
            "http://api.example.test/v1/items?page=2",
        )
        with self.assertRaisesRegex(RuntimeError, "another origin"):
            same("list", base, "http://other.example.test/v1/items?page=2")


class Unknown(unittest.TestCase):
    def test_an_unknown_style(self) -> None:
        with self.assertRaisesRegex(TypeError, "unknown pagination style"):
            step({"style": "keyset", "items": "items"}, {"items": [1]})


if __name__ == "__main__":
    unittest.main()
