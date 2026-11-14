//! The fixture API of `e2e_tests/fixtures/conformance`, in Rust.
//!
//! The handlers do what the TypeScript handlers of the fixture do. Types,
//! `Handlers` and `router()` come from `api_generated.rs`, which the
//! generator writes from the TypeScript routes.

mod api_generated;

use std::collections::BTreeMap;
use std::sync::Mutex;

use api_generated as api;

/// The notes of this server, by id.
#[derive(Default)]
struct Notes {
    notes: Mutex<BTreeMap<String, api::NotesRetrieveResponse>>,
    created: Mutex<u64>,
}

impl Notes {
    /// Replaces what the body speaks about; keeps `likes`.
    fn store(&self, id: String, body: api::NotesCreateBody) -> api::NotesRetrieveResponse {
        let mut notes = self.notes.lock().unwrap();
        let note = api::NotesRetrieveResponse {
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
}

impl api::Handlers for Notes {
    async fn notes_list(&self, query: api::NotesListQuery) -> api::NotesListResponse {
        let wanted = query.tag.unwrap_or_default();
        let notes = self.notes.lock().unwrap();
        // A BTreeMap iterates in the order of its keys: by id.
        let matching: Vec<_> = notes
            .values()
            .filter(|note| wanted.iter().all(|tag| note.tags.contains(tag)))
            .filter(|note| query.cursor.as_ref().is_none_or(|cursor| &note.id > cursor))
            .cloned()
            .collect();
        let limit = usize::try_from(query.limit).unwrap_or(0);
        let more = matching.len() > limit;
        let items: Vec<_> = matching.into_iter().take(limit).collect();
        api::NotesListResponse {
            // The last page has no cursor: the member is left out.
            cursor: if more { items.last().map(|note| note.id.clone()) } else { None },
            items,
        }
    }

    async fn notes_create(
        &self,
        body: api::NotesCreateBody,
    ) -> Result<api::NotesCreateResponse, api::NotesCreateError> {
        let taken = self.notes.lock().unwrap().values().any(|note| note.title == body.title);
        if taken {
            return Err(api::NotesCreateError::Status409(api::NotesCreateError409 {
                error: api::NotesCreateError409Error::Conflict,
                title: body.title,
            }));
        }
        let id = {
            let mut created = self.created.lock().unwrap();
            *created += 1;
            format!("n{created}")
        };
        Ok(self.store(id, body))
    }

    async fn notes_retrieve(
        &self,
        params: api::NotesRetrieveParams,
    ) -> Result<api::NotesRetrieveResponse, api::NotesRetrieveError> {
        self.notes.lock().unwrap().get(&params.id).cloned().ok_or(
            api::NotesRetrieveError::Status404(api::NotFound {
                error: api::NotFoundError::NotFound,
                id: params.id,
            }),
        )
    }

    async fn notes_update(
        &self,
        params: api::NotesUpdateParams,
        body: api::NotesUpdateBody,
    ) -> api::NotesUpdateResponse {
        self.store(params.id, body)
    }

    async fn notes_delete(
        &self,
        params: api::NotesDeleteParams,
        body: api::NotesDeleteBody,
    ) -> Result<api::NotesDeleteResponse, api::NotesDeleteError> {
        match self.notes.lock().unwrap().remove(&params.id) {
            Some(_) => Ok(api::NotesDeleteResponse { deleted: true, reason: body.reason }),
            None => Err(api::NotesDeleteError::Status404(api::NotFound {
                error: api::NotFoundError::NotFound,
                id: params.id,
            })),
        }
    }

    async fn echo_retrieve(&self, params: api::EchoRetrieveParams) -> api::EchoRetrieveResponse {
        api::EchoRetrieveResponse {
            segments: params.path.split('/').map(str::to_string).collect(),
            path: params.path,
        }
    }

    async fn shapes_create(&self, body: api::ShapesCreateBody) -> api::ShapesCreateResponse {
        let (area, kind) = match &body.shape {
            api::ShapesCreateBodyShape::Circle(circle) => {
                (3.0 * circle.radius * circle.radius, api::ShapesCreateResponseKind::Circle)
            }
            api::ShapesCreateBodyShape::Rect(rect) => {
                (rect.width * rect.height, api::ShapesCreateResponseKind::Rect)
            }
        };
        api::ShapesCreateResponse {
            area,
            kind,
            from: body.from,
            meta: api::ShapesCreateResponseMeta { data_id: body.meta.data_id, class: body.meta.class },
            unit: match body.unit {
                api::ShapesCreateBodyUnit::Mm => api::ShapesCreateResponseUnit::Mm,
                api::ShapesCreateBodyUnit::Cm => api::ShapesCreateResponseUnit::Cm,
            },
            note: body.note,
        }
    }

    async fn edges_create(&self, body: api::EdgesCreateBody) -> api::EdgesCreateResponse {
        // Which fields arrived; `maybe` and `count` given back.
        let arrived = [
            ("count", body.count.is_some()),
            ("digits", body.digits.is_some()),
            ("email", body.email.is_some()),
            ("flag", body.flag.is_some()),
            ("id", body.id.is_some()),
            // Absent is `None`; null is `Some(None)`.
            ("maybe", body.maybe.is_some()),
            ("plain", body.plain.is_some()),
            ("short", body.short.is_some()),
            ("step", body.step.is_some()),
            ("when", body.when.is_some()),
            ("word", body.word.is_some()),
        ];
        api::EdgesCreateResponse {
            received: arrived.iter().filter(|(_, there)| *there).map(|(name, _)| name.to_string()).collect(),
            maybe: body.maybe,
            count: body.count,
        }
    }

    async fn odd_create(&self, body: api::OddCreateBody) -> api::OddCreateResponse {
        // The body and the response are different types, also where they
        // have the same fields.
        fn copy(link: api::OddCreateBodyChain) -> api::OddCreateResponseChain {
            api::OddCreateResponseChain {
                name: link.name,
                next: link.next.map(|next| Box::new(copy(*next))),
                origin: link.origin.map(|origin| Box::new(copy(*origin))),
            }
        }
        fn same(expr: api::OddCreateBodyExpr) -> api::OddCreateResponseExpr {
            use api::{OddCreateBodyExpr as Body, OddCreateResponseExpr as Response};
            match expr {
                Body::Number(number) => Response::Number(number),
                Body::Variant2(neg) => Response::Variant2(api::OddCreateResponseExpr2 {
                    op: neg.op,
                    of: Box::new(same(*neg.of)),
                }),
                Body::Variant3(add) => Response::Variant3(api::OddCreateResponseExpr3 {
                    op: add.op,
                    args: add.args.into_iter().map(same).collect(),
                }),
            }
        }
        api::OddCreateResponse {
            type_: body.type_,
            created_at: body.created_at,
            created_at_2: body.created_at_2,
            _2fa: body._2fa,
            pair: body.pair,
            scores: body.scores,
            loose: body.loose,
            loose_or_null: body.loose_or_null,
            version: body.version,
            anything: body.anything,
            chain: copy(body.chain),
            // The same type in the body and in the response.
            json: body.json,
            json_if_any: body.json_if_any,
            expr: same(body.expr),
            limit: body.limit,
        }
    }

    async fn trees_create(&self, body: api::TreesCreateBody) -> api::TreesCreateResponse {
        fn depth(tree: &api::TreesCreateBody) -> i64 {
            1 + tree.children.iter().map(depth).max().unwrap_or(0)
        }
        fn copy(tree: &api::TreesCreateBody) -> api::TreesCreateResponseRoot {
            api::TreesCreateResponseRoot {
                name: tree.name.clone(),
                children: tree.children.iter().map(copy).collect(),
            }
        }
        api::TreesCreateResponse { depth: depth(&body), root: copy(&body) }
    }
}

#[tokio::main]
async fn main() {
    // Port 0: the system picks one, and the address is printed for the
    // script that runs the tests.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    println!("http://{}", listener.local_addr().expect("the bound address"));
    axum::serve(listener, api::router(Notes::default())).await.expect("the server runs");
}
