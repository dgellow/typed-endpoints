//! The fixture API of `e2e_tests/fixtures/conformance`, in Rust.
//!
//! The handlers do what the TypeScript handlers of the fixture do. The
//! types, `Handlers` and `router()` come from `api_generated.rs`, which the
//! generator writes from the TypeScript routes.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use typed_endpoints_rust_e2e::api_generated as api;

use api::Note;

/// The notes of this server, by id.
#[derive(Default)]
struct Notes {
    notes: Mutex<BTreeMap<String, Note>>,
    created: Mutex<u64>,
}

impl Notes {
    fn notes(&self) -> MutexGuard<'_, BTreeMap<String, Note>> {
        self.notes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replaces what the body speaks about; keeps `likes`.
    fn store(&self, id: String, body: api::NotesCreateBody) -> Note {
        let mut notes = self.notes();
        let note = Note {
            likes: notes.get(&id).map_or(0, |note| note.likes),
            id: id.clone(),
            title: body.title,
            tags: body.tags,
            // Absent stays absent: `None` is left out of the response.
            pinned: body.pinned,
        };
        notes.insert(id, note.clone());
        note
    }

    fn not_found(id: String) -> api::NotFound {
        api::NotFound { id }
    }
}

#[expect(
    clippy::unused_async_trait_impl,
    reason = "the notes are kept in memory, so no handler here has anything to await; \
              a handler of a real service does, and is written the same way"
)]
impl api::Handlers for Notes {
    async fn notes_list(
        &self,
        query: api::NotesListQuery,
    ) -> Result<api::NotesListResponse, api::InternalError> {
        let wanted = query.tag.unwrap_or_default();
        let after = query.cursor.unwrap_or_default();
        let limit = usize::try_from(query.limit).unwrap_or(usize::MAX);
        // A BTreeMap iterates in the order of its keys: by id.
        let mut matching = self
            .notes()
            .values()
            .filter(|note| note.id > after)
            .filter(|note| wanted.iter().all(|tag| note.tags.contains(tag)))
            .cloned()
            .collect::<Vec<_>>();
        // The last page has no cursor: the member is left out.
        let more = matching.len() > limit;
        matching.truncate(limit);
        Ok(api::NotesListResponse {
            cursor: matching.last().filter(|_| more).map(|note| note.id.clone()),
            items: matching,
        })
    }

    async fn notes_create(
        &self,
        body: api::NotesCreateBody,
    ) -> Result<Note, api::NotesCreateError> {
        if self.notes().values().any(|note| note.title == body.title) {
            return Err(api::NotesCreateError::Conflict(api::NotesCreateError409 {
                title: body.title,
            }));
        }
        let id = {
            let mut created = self.created.lock().unwrap_or_else(PoisonError::into_inner);
            *created += 1;
            format!("n{created}")
        };
        Ok(self.store(id, body))
    }

    async fn notes_retrieve(
        &self,
        params: api::NotesRetrieveParams,
    ) -> Result<Note, api::NotesRetrieveError> {
        let found = self.notes().get(&params.id).cloned();
        // A declared error body converts into the operation's error.
        found.ok_or_else(|| Self::not_found(params.id).into())
    }

    async fn notes_update(
        &self,
        params: api::NotesUpdateParams,
        body: api::NotesUpdateBody,
    ) -> Result<Note, api::InternalError> {
        Ok(self.store(params.id, body))
    }

    async fn notes_delete(
        &self,
        params: api::NotesDeleteParams,
        body: api::NotesDeleteBody,
    ) -> Result<api::NotesDeleteResponse, api::NotesDeleteError> {
        match self.notes().remove(&params.id) {
            Some(_) => Ok(api::NotesDeleteResponse {
                deleted: true,
                reason: body.reason,
            }),
            None => Err(Self::not_found(params.id).into()),
        }
    }

    async fn echo_retrieve(
        &self,
        params: api::EchoRetrieveParams,
    ) -> Result<api::EchoRetrieveResponse, api::InternalError> {
        // A failure that is not part of the contract.
        if params.path == "fail" {
            return Err("the backend is down".into());
        }
        Ok(api::EchoRetrieveResponse {
            segments: params.path.split('/').map(str::to_owned).collect(),
            path: params.path,
        })
    }

    async fn shapes_create(
        &self,
        body: api::ShapesCreateBody,
    ) -> Result<api::ShapesCreateResponse, api::InternalError> {
        use api::ShapesCreateBodyShape as Shape;
        use api::ShapesCreateResponseKind as Kind;

        let (area, kind) = match &body.shape {
            Shape::Circle(circle) => (3.0 * circle.radius * circle.radius, Kind::Circle),
            Shape::Rect(rect) => (rect.width * rect.height, Kind::Rect),
        };
        Ok(api::ShapesCreateResponse {
            area,
            kind,
            from: body.from,
            meta: body.meta,
            unit: body.unit,
            note: body.note,
        })
    }

    async fn edges_create(
        &self,
        body: api::EdgesCreateBody,
    ) -> Result<api::EdgesCreateResponse, api::InternalError> {
        // Which members arrived; `maybe` and `count` given back.
        let arrived = [
            ("count", body.count.is_some()),
            ("digits", body.digits.is_some()),
            ("email", body.email.is_some()),
            ("flag", body.flag.is_some()),
            ("id", body.id.is_some()),
            // Null is a member that arrived.
            ("maybe", !body.maybe.is_absent()),
            ("plain", body.plain.is_some()),
            ("short", body.short.is_some()),
            ("step", body.step.is_some()),
            ("when", body.when.is_some()),
            ("word", body.word.is_some()),
        ];
        Ok(api::EdgesCreateResponse {
            received: arrived
                .iter()
                .filter(|(_, there)| *there)
                .map(|(name, _)| (*name).to_owned())
                .collect(),
            maybe: body.maybe,
            count: body.count,
        })
    }

    async fn odd_create(
        &self,
        body: api::OddCreateBody,
    ) -> Result<api::OddCreateResponse, api::InternalError> {
        // The response is the body's type: what it was sent.
        Ok(body)
    }

    async fn trees_create(
        &self,
        body: api::TreesCreateBody,
    ) -> Result<api::TreesCreateResponse, api::InternalError> {
        fn depth(tree: &api::TreesCreateBody) -> u64 {
            1 + tree.children.iter().map(depth).max().unwrap_or(0)
        }

        Ok(api::TreesCreateResponse {
            // Any error converts into `InternalError`: a 500, and logged.
            depth: i64::try_from(depth(&body))?,
            root: body,
        })
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Port 0: the system picks one, and the address is printed for the
    // script that runs the tests.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    println!("http://{}", listener.local_addr()?);
    axum::serve(listener, api::router(Notes::default())).await
}
