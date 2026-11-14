"""The fixture API of e2e_tests/fixtures/conformance, in Python.

The handlers do what the TypeScript handlers of the fixture do. Models,
`Handlers` and `create_app()` come from `api_generated.py`, which the
generator writes from the TypeScript routes.
"""

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi.responses import Response

import api_generated as api

Note = api.Note


class Notes:
    """Implements `api.Handlers` with the notes in memory."""

    def __init__(self) -> None:
        self.notes: dict[str, Note] = {}
        self.created = 0

    async def notes_list(
        self, query: api.NotesListQuery
    ) -> api.NotesListResponse | Response:
        wanted = query.tag or []
        matching = sorted(
            (
                note
                for note in self.notes.values()
                if all(tag in note.tags for tag in wanted)
                and (query.cursor is None or note.id > query.cursor)
            ),
            key=lambda note: note.id,
        )
        items = matching[: query.limit]
        # The cursor stays unset on the last page: absent, not null.
        if len(matching) > len(items):
            return api.NotesListResponse(items=items, cursor=items[-1].id)
        return api.NotesListResponse(items=items)

    async def notes_create(
        self, body: api.NotesCreateBody
    ) -> (
        api.Note
        | api.Fail[Literal[409], api.NotesCreateError409]
        | Response
    ):
        for note in self.notes.values():
            if note.title == body.title:
                return api.Fail(
                    409, api.NotesCreateError409(error="conflict", title=body.title)
                )
        self.created += 1
        return self._store(f"n{self.created}", 0, body)

    async def notes_retrieve(
        self, params: api.NotesRetrieveParams
    ) -> api.Note | api.Fail[Literal[404], api.NotFound] | Response:
        note = self.notes.get(params.id)
        if note is None:
            return api.Fail(404, api.NotFound(error="not_found", id=params.id))
        return note

    async def notes_update(
        self, params: api.NotesUpdateParams, body: api.NotesUpdateBody
    ) -> api.Note | Response:
        current = self.notes.get(params.id)
        return self._store(params.id, current.likes if current else 0, body)

    async def notes_delete(
        self, params: api.NotesDeleteParams, body: api.NotesDeleteBody
    ) -> api.NotesDeleteResponse | api.Fail[Literal[404], api.NotFound] | Response:
        if self.notes.pop(params.id, None) is None:
            return api.Fail(404, api.NotFound(error="not_found", id=params.id))
        return api.NotesDeleteResponse(deleted=True, reason=body.reason)

    async def echo_retrieve(
        self, params: api.EchoRetrieveParams
    ) -> api.EchoRetrieveResponse | Response:
        # A failure that is not part of the contract.
        if params.path == "fail":
            raise RuntimeError("the backend is down")
        return api.EchoRetrieveResponse(
            path=params.path, segments=params.path.split("/")
        )

    async def shapes_create(
        self, body: api.ShapesCreateBody
    ) -> api.ShapesCreateResponse | Response:
        shape = body.shape
        if isinstance(shape, api.ShapesCreateBodyShapeCircle):
            area = 3 * shape.radius * shape.radius
        else:
            area = shape.width * shape.height
        return api.ShapesCreateResponse(
            area=area,
            kind=shape.kind,
            from_=body.from_,
            # Only what the request set: an absent `class` stays absent.
            meta=api.ShapesCreateResponseMeta.model_validate(
                body.meta.model_dump(by_alias=True, exclude_unset=True)
            ),
            unit=body.unit,
            note=body.note,
        )

    async def odd_create(
        self, body: api.OddCreateBody
    ) -> api.OddCreateResponse | Response:
        # What was sent, and the default the body's model filled in.
        sent = body.model_dump(by_alias=True, exclude_unset=True)
        return api.OddCreateResponse.model_validate({**sent, "limit": body.limit})

    async def trees_create(
        self, body: api.TreesCreateBody
    ) -> api.TreesCreateResponse | Response:
        def depth(tree: api.TreesCreateBody) -> int:
            return 1 + max((depth(child) for child in tree.children), default=0)

        return api.TreesCreateResponse(
            depth=depth(body),
            root=api.TreesCreateResponseRoot.model_validate(body.model_dump()),
        )

    async def ticks_list(
        self, query: api.TicksListQuery, last_event_id: str | None
    ) -> AsyncIterator[api.TicksListEvent]:
        if query.pause is not None:
            await asyncio.sleep(query.pause / 1000)
        # A client that reconnects continues after the event it has.
        start = 0 if last_event_id is None else int(last_event_id) + 1
        for n in range(start, query.count):
            if last_event_id is None and n == query.failAt:
                raise RuntimeError("backend went away")
            if n == query.badAt:
                # Built unchecked: an event its model rejects.
                yield api.TicksListTickEvent(
                    data=api.TicksListTickData.model_construct(n="not a number")
                )
            yield api.TicksListTickEvent(data=api.TicksListTickData(n=n), id=str(n))
        yield api.TicksListDoneEvent(data=api.TicksListDoneData(total=query.count))

    async def edges_create(
        self, body: api.EdgesCreateBody
    ) -> api.EdgesCreateResponse | Response:
        # Which fields arrived; `maybe` and `count` given back.
        answer: dict[str, Any] = {"received": sorted(body.model_fields_set)}
        if "maybe" in body.model_fields_set:
            answer["maybe"] = body.maybe
        if body.count is not None:
            answer["count"] = body.count
        return api.EdgesCreateResponse.model_validate(answer)

    def _store(self, note_id: str, likes: int, body: api.NotesCreateBody) -> Note:
        # Only the fields the body set: an absent `pinned` stays absent.
        note = Note.model_validate(
            {"id": note_id, "likes": likes, **body.model_dump(exclude_unset=True)}
        )
        self.notes[note_id] = note
        return note


app = api.create_app(Notes())
