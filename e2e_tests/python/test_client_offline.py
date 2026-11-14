"""What the generated client does with answers the API would not give.

`test_client.py` runs against servers that keep to the contract. These
answers come from something else: a proxy, a framework's own error page.
"""

import unittest

import httpx

import client_generated as api


def client(status: int, body: bytes, kind: str = "application/json") -> api.Client:
    """Make a client whose every request gets the same answer."""

    def answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers={"content-type": kind})

    return api.Client(
        "http://api", http=httpx.Client(transport=httpx.MockTransport(answer))
    )


class Answers(unittest.TestCase):
    def test_a_declared_status_with_another_body_is_an_api_error(self) -> None:
        # A 404 of a proxy, not of the operation.
        html = client(404, b"<html>Not Found</html>", "text/html")
        with self.assertRaises(api.ApiError) as raised:
            html.notes_retrieve_result("n1")
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(raised.exception.body, "<html>Not Found</html>")

        # The operation's own 404 is still a value.
        declared = client(404, b'{"error": "not_found", "id": "n1"}')
        result = declared.notes_retrieve_result("n1")
        self.assertIsInstance(result, api.Fail)

    def test_a_success_that_is_not_the_response_is_a_response_error(self) -> None:
        wrong = client(200, b"[1, 2]")
        with self.assertRaises(api.ResponseError) as raised:
            wrong.notes_retrieve("n1")
        self.assertEqual(raised.exception.status, 200)
        self.assertEqual(raised.exception.body, [1, 2])
        # An `ApiError`, so one `except` covers every answer that is not
        # the response.
        self.assertIsInstance(raised.exception, api.ApiError)

    def test_items_of_something_that_is_not_a_page(self) -> None:
        wrong = client(200, b"[1, 2]")
        with self.assertRaises(api.ResponseError):
            list(wrong.notes_list_pages())
        # Not an empty list.
        with self.assertRaises(api.ResponseError):
            list(wrong.notes_list_items())


class Paths(unittest.TestCase):
    def setUp(self) -> None:
        self.requested: list[str] = []

        def record(request: httpx.Request) -> httpx.Response:
            self.requested.append(f"{request.method} {request.url.raw_path.decode()}")
            return httpx.Response(200, json={"path": "a", "segments": ["a"]})

        self.client = api.Client(
            "http://api", http=httpx.Client(transport=httpx.MockTransport(record))
        )

    def test_a_parameter_is_one_segment(self) -> None:
        self.client.echo_retrieve("a b/c?d")
        self.assertEqual(self.requested, ["GET /api/echo/a%20b/c%3Fd"])

    def test_a_segment_that_names_another_path_is_refused(self) -> None:
        # A URL with `..` in it is the URL of another path: no request is sent.
        for value in ("..", ".", ""):
            with self.subTest(value=value), self.assertRaises(api.PathError):
                self.client.notes_retrieve(value)
        for value in ("../../admin", "a/./b", "a/.."):
            with self.subTest(value=value), self.assertRaises(api.PathError):
                self.client.echo_retrieve(value)
        self.assertEqual(self.requested, [])


class Lifecycle(unittest.TestCase):
    def test_a_client_closes_what_it_made_and_leaves_what_it_was_given(self) -> None:
        given = httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(204))
        )
        with api.Client("http://api", http=given):
            pass
        self.assertFalse(given.is_closed)
        given.close()

        with api.Client("http://api") as made:
            http = made._http  # pyright: ignore[reportPrivateUsage]
        self.assertTrue(http.is_closed)


if __name__ == "__main__":
    unittest.main()
