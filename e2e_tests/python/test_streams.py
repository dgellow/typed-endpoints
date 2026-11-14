"""What the generated module does with the generator of an event stream.

The conformance tests cover the frames. These cover what a handler may do
between two events, and events that cannot be written.
"""

import asyncio
import contextvars
import logging
import unittest
from collections.abc import AsyncIterator

import api_generated as api

EVENTS = api._TICKS_LIST_EVENTS  # pyright: ignore[reportPrivateUsage]
STATE: contextvars.ContextVar[str] = contextvars.ContextVar("STATE", default="unset")


def tick(n: int, identifier: str | None = None) -> api.TicksListTickEvent:
    """Make the event `tick`."""
    return api.TicksListTickEvent(data=api.TicksListTickData(n=n), id=identifier)


async def frames(source: AsyncIterator[object]) -> list[str]:
    """Collect the frames the module writes for a handler's events."""
    written = api._frames("GET /api/ticks", source, EVENTS, None)  # pyright: ignore[reportPrivateUsage]
    return [frame async for frame in written]


class Streams(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        # What the module logs here is what the tests provoke.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

    async def test_the_generator_runs_in_one_task(self) -> None:
        seen: list[str] = []

        async def source() -> AsyncIterator[api.TicksListEvent]:
            STATE.set("set before the first event")
            yield tick(0)
            # Still there after the event was written.
            seen.append(STATE.get())
            yield tick(1)

        self.assertEqual(len(await frames(source())), 2)
        self.assertEqual(seen, ["set before the first event"])

    async def test_a_timeout_around_events_ends_the_stream(self) -> None:
        async def source() -> AsyncIterator[api.TicksListEvent]:
            async with asyncio.timeout(0.02):
                yield tick(0)
                await asyncio.sleep(1)
                yield tick(1)

        written = await frames(source())
        self.assertEqual(written, ['event: tick\ndata: {"n":0}\n\n', ": error\n\n"])

    async def test_the_generator_is_closed_when_the_stream_is(self) -> None:
        closed = asyncio.Event()

        async def source() -> AsyncIterator[api.TicksListEvent]:
            try:
                yield tick(0)
                yield tick(1)
            finally:
                closed.set()

        written = api._frames("GET /api/ticks", source(), EVENTS, None)  # pyright: ignore[reportPrivateUsage]
        # A client that leaves after the first event.
        first = await anext(written)
        self.assertEqual(first, 'event: tick\ndata: {"n":0}\n\n')
        await written.aclose()  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType]
        self.assertTrue(closed.is_set())

    async def test_an_id_with_a_line_break_is_not_written(self) -> None:
        async def source() -> AsyncIterator[api.TicksListEvent]:
            yield tick(0, "0")
            # It would be read as a second event.
            yield tick(1, '1\ndata: {"n":999}\n\nevent: done')

        written = await frames(source())
        self.assertEqual(
            written, ['event: tick\nid: 0\ndata: {"n":0}\n\n', ": error\n\n"]
        )

    async def test_an_event_its_model_rejects_ends_the_stream(self) -> None:
        async def source() -> AsyncIterator[api.TicksListEvent]:
            yield tick(0)
            yield api.TicksListTickEvent(
                data=api.TicksListTickData.model_construct(n="not a number")
            )
            yield tick(2)

        written = await frames(source())
        self.assertEqual(written, ['event: tick\ndata: {"n":0}\n\n', ": error\n\n"])


if __name__ == "__main__":
    unittest.main()
