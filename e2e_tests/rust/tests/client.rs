//! The generated client against a server of the fixture API.
//!
//! Run by `./scripts/test-rust`, once against the fixture's TypeScript
//! handlers and once against the generated axum server: `API_URL` says
//! where. Without a server there is nothing to run, so the tests are
//! ignored by a plain `cargo test`.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use typed_endpoints_rust_e2e::client_generated as api;

fn client() -> api::Client {
    let url = std::env::var("API_URL").expect("API_URL is not set; run ./scripts/test-rust");
    api::Client::new(&url)
}

/// A name no other test, run or note of the server uses.
fn unique(prefix: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{now:x}-{count}")
}

fn note(title: &str, tags: &[&str]) -> api::NotesCreateBody {
    api::NotesCreateBody {
        title: title.to_owned(),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        pinned: None,
    }
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn a_note_is_created_read_replaced_and_deleted() {
    let client = client();
    let created = client
        .notes_create(&note(&unique("crud"), &["a"]))
        .await
        .expect("the note is created");
    assert_eq!(created.likes, 0);
    assert_eq!(created.tags, ["a"]);
    // Not set in the request, absent in the response.
    assert_eq!(created.pinned, None);

    let read = client
        .notes_retrieve(&created.id)
        .await
        .expect("it is there");
    assert_eq!(read, created);

    let title = unique("replaced");
    let replaced = client
        .notes_update(&created.id, &note(&title, &[]))
        .await
        .expect("it is replaced");
    assert_eq!(replaced.title, title);
    assert_eq!(replaced.tags, Vec::<String>::new());

    // A DELETE with a body, which the server reads.
    let reason = api::NotesDeleteBody {
        reason: "done with it".to_owned(),
    };
    let deleted = client
        .notes_delete(&created.id, &reason)
        .await
        .expect("it is deleted");
    assert_eq!(deleted.reason, "done with it");
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn a_declared_error_is_a_variant_with_its_body() {
    let client = client();
    let missing = unique("missing");
    match client.notes_retrieve(&missing).await {
        Err(api::NotesRetrieveError::NotFound(body)) => assert_eq!(body.id, missing),
        other => panic!("expected the declared 404, got {other:?}"),
    }

    // A title is taken once: the second note is the declared 409.
    let title = unique("taken");
    client
        .notes_create(&note(&title, &[]))
        .await
        .expect("the first note is created");
    match client.notes_create(&note(&title, &[])).await {
        Err(api::NotesCreateError::Conflict(body)) => assert_eq!(body.title, title),
        other => panic!("expected the declared 409, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn a_status_that_is_not_declared_is_another_error() {
    let client = client();
    let created = client
        .notes_create(&note(&unique("short"), &[]))
        .await
        .expect("the note is created");
    // A reason shorter than the contract allows: a 400, which the DELETE
    // does not declare.
    let reason = api::NotesDeleteBody {
        reason: "no".to_owned(),
    };
    match client.notes_delete(&created.id, &reason).await {
        Err(api::NotesDeleteError::Other(api::Error::Status { status, body })) => {
            assert_eq!(status.as_u16(), 400);
            assert!(body.contains("reason"), "{body}");
        }
        other => panic!("expected a status that is not declared, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn pages_and_items_follow_the_cursor() {
    let client = client();
    let tag = unique("listed");
    let mut titles = Vec::new();
    for _ in 0..5 {
        let title = unique("page");
        client
            .notes_create(&note(&title, &[tag.as_str()]))
            .await
            .expect("the note is created");
        titles.push(title);
    }
    let query = api::NotesListQuery {
        tag: Some(vec![tag]),
        limit: 2,
        ..api::NotesListQuery::default()
    };

    let mut sizes = Vec::new();
    let mut pages = client.notes_list_pages(&query);
    while let Some(page) = pages.next().await.expect("the page is read") {
        sizes.push(page.items.len());
    }
    assert_eq!(sizes, [2, 2, 1]);

    let mut listed = Vec::new();
    let mut items = client.notes_list_items(&query);
    while let Some(item) = items.next().await.expect("the item is read") {
        listed.push(item.title);
    }
    listed.sort();
    titles.sort();
    assert_eq!(listed, titles);
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn a_path_parameter_is_encoded_and_cannot_name_another_path() {
    let client = client();
    let echoed = client
        .echo_retrieve("docs/q1 report.md")
        .await
        .expect("the path is echoed");
    assert_eq!(echoed.path, "docs/q1 report.md");
    assert_eq!(echoed.segments, ["docs", "q1 report.md"]);

    // Refused before a request is sent: the URL would be the list's.
    for id in ["..", ".", ""] {
        match client.notes_retrieve(id).await {
            Err(api::NotesRetrieveError::Other(api::Error::Request(_))) => {}
            other => panic!("expected {id:?} to be refused, got {other:?}"),
        }
    }
    assert!(matches!(
        client.echo_retrieve("../../admin").await,
        Err(api::Error::Request(_))
    ));
}

#[tokio::test]
#[ignore = "needs a server: run by ./scripts/test-rust"]
async fn a_union_and_a_type_inside_itself_cross_the_wire() {
    let client = client();
    let circle = api::ShapesCreateBody {
        shape: api::ShapesCreateBodyShape::Circle(api::ShapesCreateBodyShapeCircle { radius: 2.0 }),
        from: "sketch".to_owned(),
        meta: api::ShapesCreateBodyMeta {
            data_id: "m1".to_owned(),
            class: None,
        },
        unit: api::ShapesCreateBodyUnit::Cm,
        note: None,
    };
    let answer = client
        .shapes_create(&circle)
        .await
        .expect("the shape is answered");
    assert_eq!(answer.kind, api::ShapesCreateResponseKind::Circle);
    assert_eq!(answer.meta, circle.meta);
    assert_eq!(answer.note, None);

    let leaf = |name: &str| api::TreesCreateBody {
        name: name.to_owned(),
        children: Vec::new(),
    };
    let tree = api::TreesCreateBody {
        name: "root".to_owned(),
        children: vec![
            leaf("a"),
            api::TreesCreateBody {
                name: "b".to_owned(),
                children: vec![leaf("c")],
            },
        ],
    };
    let measured = client
        .trees_create(&tree)
        .await
        .expect("the tree is answered");
    assert_eq!(measured.depth, 3);
    assert_eq!(measured.root, tree);
}
