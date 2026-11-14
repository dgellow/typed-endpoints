/**
 * The fixed parts of a generated Rust client: its public types and the
 * private module that sends requests, reads answers and follows a list
 * from page to page.
 *
 * It is Rust source, written as a person would write it: it passes
 * `cargo clippy -- -D warnings -W clippy::pedantic` and is kept as
 * rustfmt writes it. It is inside `String.raw` templates, so it holds no
 * backtick and no `${`.
 *
 * @module
 */

/** `Error`: why a call did not return what its operation declares. */
export const CLIENT_ERROR = String.raw`
/// Why a call did not return what its operation declares.
#[derive(Debug)]
pub enum Error {
    /// The request was not sent, or its answer not read.
    Transport(reqwest::Error),
    /// A status the operation does not declare, with the body it came with.
    Status {
        /// The status of the answer.
        status: StatusCode,
        /// Its body, as text.
        body: String,
    },
    /// A body that is not what the operation declares for a success.
    Body {
        /// The status of the answer.
        status: StatusCode,
        /// Why the body is not the declared one.
        error: serde_json::Error,
    },
    /// A request that cannot be written: a path parameter that would make
    /// it go to another path, a query that is not made of values.
    Request(String),
    /// A list that cannot be followed to its next page.
    Pagination(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "the request failed: {error}"),
            Self::Status { status, .. } => write!(f, "the answer has the status {status}"),
            Self::Body { status, error } => {
                write!(
                    f,
                    "the body of the {status} answer is not the declared one: {error}"
                )
            }
            Self::Request(reason) | Self::Pagination(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Body { error, .. } => Some(error),
            Self::Status { .. } | Self::Request(_) | Self::Pagination(_) => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error)
    }
}
`.trim();

/** `Pages` and `Items`: public types, written when a list is paginated. */
export const CLIENT_PAGES = String.raw`
/// The pages of a list. Asking for the next one sends a request.
#[derive(Debug)]
pub struct Pages<'a, P> {
    client: &'a Client,
    /// The method of the client, for messages.
    call: &'static str,
    method: Method,
    meta: &'static runtime::Pagination,
    /// What to ask for next; nothing once the list has ended.
    next: Option<Result<runtime::Ask, Error>>,
    /// The size of the first page: the size of a page, where the query
    /// does not say.
    size: Option<usize>,
    page: PhantomData<fn() -> P>,
}

impl<'a, P: DeserializeOwned> Pages<'a, P> {
    fn new(
        client: &'a Client,
        call: &'static str,
        method: Method,
        path: Result<String, Error>,
        query: Result<Vec<(String, String)>, Error>,
        meta: &'static runtime::Pagination,
    ) -> Self {
        // A request that cannot be written is the error of the first call.
        let first = path.and_then(|path| {
            Ok(runtime::Ask {
                url: format!("{}{path}", client.base_url),
                query: query?,
            })
        });
        Self {
            client,
            call,
            method,
            meta,
            next: Some(first),
            size: None,
            page: PhantomData,
        }
    }

    /// The next page, or nothing after the last one.
    ///
    /// # Errors
    ///
    /// As a call of the operation. Also when the next page cannot be found:
    /// the server gave back the cursor it was asked with, or the next page
    /// is on another origin.
    pub async fn next(&mut self) -> Result<Option<P>, Error> {
        let Some(page) = self.next_value().await? else {
            return Ok(None);
        };
        serde_json::from_value(page)
            .map(Some)
            .map_err(runtime::not_declared)
    }

    /// The next page as it was sent.
    async fn next_value(&mut self) -> Result<Option<Value>, Error> {
        let Some(ask) = self.next.take().transpose()? else {
            return Ok(None);
        };
        let answer = runtime::send(
            &self.client.http,
            self.method.clone(),
            &ask.url,
            &ask.query,
            None,
        )
        .await?;
        let page: Value = answer.success()?;
        let size = *self
            .size
            .get_or_insert_with(|| runtime::items(&page, self.meta).len());
        // Where the next page is. If that cannot be said, this page is
        // still given, and the call after it fails.
        self.next = runtime::next_page(self.call, self.meta, &page, &ask, size).transpose();
        Ok(Some(page))
    }
}

/// The items of a list, across its pages. Asking for the next one sends a
/// request when the items of the page before are used up.
#[derive(Debug)]
pub struct Items<'a, P, T> {
    pages: Pages<'a, P>,
    /// The items of the page that was read last and that were not given yet.
    page: std::vec::IntoIter<Value>,
    item: PhantomData<fn() -> T>,
}

impl<'a, P: DeserializeOwned, T: DeserializeOwned> Items<'a, P, T> {
    fn new(pages: Pages<'a, P>) -> Self {
        Self {
            pages,
            page: Vec::new().into_iter(),
            item: PhantomData,
        }
    }

    /// The next item, or nothing after the last one.
    ///
    /// # Errors
    ///
    /// As for a page, when one has to be asked for.
    pub async fn next(&mut self) -> Result<Option<T>, Error> {
        loop {
            if let Some(item) = self.page.next() {
                return serde_json::from_value(item)
                    .map(Some)
                    .map_err(runtime::not_declared);
            }
            let Some(page) = self.pages.next_value().await? else {
                return Ok(None);
            };
            // Read as a page first: something else is not an empty list.
            P::deserialize(&page).map_err(runtime::not_declared)?;
            self.page = runtime::items(&page, self.pages.meta).to_vec().into_iter();
        }
    }
}
`.trim();

/** The private module of a client. */
export const CLIENT_RUNTIME = String.raw`
/// Writes requests, reads answers and finds the next page of a list. The
/// module's API is its types and the client; nothing in here is part of
/// it.
#[allow(
    dead_code,
    reason = "one runtime for every API: this one may not have each kind of operation"
)]
mod runtime {
    use std::fmt::Write as _;

    use reqwest::{Method, StatusCode, Url};
    use serde::de::DeserializeOwned;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    use super::Error;

    // -------------------------------------------------------------------------
    // Requests
    // -------------------------------------------------------------------------

    /// Writes a text as part of a path: every byte that is not a letter, a
    /// digit or one of -._~ is percent-encoded.
    fn encode(text: &str, out: &mut String) {
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                out.push(char::from(byte));
            } else {
                // Writing to a String does not fail.
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }

    /// A path parameter as one segment of a URL.
    ///
    /// An empty one and the dot segments are refused: a URL with such a
    /// segment is the URL of another path, also when the dots are
    /// percent-encoded.
    pub(super) fn segment(value: &str) -> Result<String, Error> {
        if value.is_empty() || value == "." || value == ".." {
            return Err(Error::Request(format!(
                "{value:?} cannot be a segment of a path: the request would go to another path"
            )));
        }
        let mut out = String::with_capacity(value.len());
        encode(value, &mut out);
        Ok(out)
    }

    /// A catch-all path parameter: it spans segments, so its slashes are
    /// kept and each segment is encoded.
    pub(super) fn rest(value: &str) -> Result<String, Error> {
        let mut out = String::with_capacity(value.len());
        for (index, part) in value.split('/').enumerate() {
            if part == "." || part == ".." {
                return Err(Error::Request(format!(
                    "{value:?} has a segment that is \".\" or \"..\": the request would go to \
                     another path"
                )));
            }
            if index > 0 {
                out.push('/');
            }
            encode(part, &mut out);
        }
        Ok(out)
    }

    /// A value of a query as text; nothing for null.
    fn text(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            Value::Null | Value::Array(_) | Value::Object(_) => None,
        }
    }

    /// A query as the pairs of a query string. A member that is not set is
    /// left out, and a list repeats its name.
    pub(super) fn pairs<Q: Serialize>(query: &Q) -> Result<Vec<(String, String)>, Error> {
        let unwritable = |name: &str| {
            Error::Request(format!(
                "the query member {name:?} is not a value or a list of values"
            ))
        };
        let Value::Object(members) = serde_json::to_value(query)
            .map_err(|error| Error::Request(format!("the query cannot be written: {error}")))?
        else {
            return Err(Error::Request("the query is not an object".to_owned()));
        };
        let mut pairs = Vec::with_capacity(members.len());
        for (name, value) in members {
            match value {
                Value::Null => {}
                Value::Array(items) => {
                    for item in &items {
                        pairs.push((name.clone(), text(item).ok_or_else(|| unwritable(&name))?));
                    }
                }
                Value::Object(_) => return Err(unwritable(&name)),
                scalar => {
                    if let Some(text) = text(&scalar) {
                        pairs.push((name, text));
                    }
                }
            }
        }
        Ok(pairs)
    }

    /// A body as JSON.
    pub(super) fn body<B: Serialize>(body: &B) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(body)
            .map_err(|error| Error::Request(format!("the body cannot be written: {error}")))
    }

    /// The answer to a request: its status and its body.
    #[derive(Debug)]
    pub(super) struct Answer {
        status: StatusCode,
        body: Vec<u8>,
    }

    impl Answer {
        pub(super) fn status(&self) -> u16 {
            self.status.as_u16()
        }

        /// The answer as an error: its status is not one the operation
        /// declares, or its body not what is declared for it.
        fn unexpected(&self) -> Error {
            Error::Status {
                status: self.status,
                body: String::from_utf8_lossy(&self.body).into_owned(),
            }
        }

        /// The body of an error the operation declares. A body that is
        /// something else comes from something that is not the API (a
        /// proxy, a framework's own answer): the status is what is known.
        pub(super) fn declared<T: DeserializeOwned>(&self) -> Result<T, Error> {
            serde_json::from_slice(&self.body).map_err(|_| self.unexpected())
        }

        /// The body of a success; any other status is an error.
        pub(super) fn success<T: DeserializeOwned>(&self) -> Result<T, Error> {
            if !self.status.is_success() {
                return Err(self.unexpected());
            }
            serde_json::from_slice(&self.body).map_err(|error| Error::Body {
                status: self.status,
                error,
            })
        }

        /// A success of an operation without a response.
        pub(super) fn done(&self) -> Result<(), Error> {
            if self.status.is_success() {
                Ok(())
            } else {
                Err(self.unexpected())
            }
        }
    }

    /// A page or an item that is not what its type says.
    pub(super) fn not_declared(error: serde_json::Error) -> Error {
        Error::Body {
            status: StatusCode::OK,
            error,
        }
    }

    /// Sends a request and reads its answer whole.
    pub(super) async fn send(
        http: &reqwest::Client,
        method: Method,
        url: &str,
        query: &[(String, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Answer, Error> {
        let mut request = http.request(method, url);
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let response = request.send().await?;
        let status = response.status();
        let body = response.bytes().await?.to_vec();
        Ok(Answer { status, body })
    }

    // -------------------------------------------------------------------------
    // Pagination
    // -------------------------------------------------------------------------

    /// How a list is paginated: where its items are, and how the page
    /// after a page is asked for.
    #[derive(Debug)]
    pub(super) enum Pagination {
        /// The page names the cursor of the next one.
        Cursor {
            items: &'static str,
            cursor: &'static str,
            cursor_param: &'static str,
        },
        /// The id of the last item is where the next page starts.
        CursorId {
            items: &'static str,
            id_field: &'static str,
            cursor_id_param: &'static str,
            limit_param: Option<&'static str>,
        },
        /// The next page starts after the items seen so far.
        Offset {
            items: &'static str,
            total: &'static str,
            offset_param: &'static str,
        },
        /// Pages are numbered.
        Page {
            items: &'static str,
            total: Option<&'static str>,
            total_pages: Option<&'static str>,
            page_param: &'static str,
            per_page_param: Option<&'static str>,
        },
        /// The page gives the URL of the next one.
        Url {
            items: &'static str,
            next_url: &'static str,
        },
    }

    /// A request for a page: where, and with which query.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) struct Ask {
        pub(super) url: String,
        pub(super) query: Vec<(String, String)>,
    }

    /// The value at a field of a page, or at a dotted path.
    fn at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
        path.split('.').try_fold(value, |value, key| value.get(key))
    }

    /// The items of a page; none if the page has no list where it should.
    pub(super) fn items<'a>(page: &'a Value, meta: &Pagination) -> &'a [Value] {
        let (Pagination::Cursor { items, .. }
        | Pagination::CursorId { items, .. }
        | Pagination::Offset { items, .. }
        | Pagination::Page { items, .. }
        | Pagination::Url { items, .. }) = meta;
        at(page, items)
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }

    /// The value of a query parameter.
    fn param<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
        let (_, value) = query.iter().find(|(known, _)| known == name)?;
        Some(value)
    }

    /// A query parameter as a count.
    fn count_of(query: &[(String, String)], name: &str) -> Option<u64> {
        param(query, name)?.parse().ok()
    }

    /// The same request with one query parameter set.
    fn with(ask: &Ask, name: &str, value: String) -> Ask {
        let mut query: Vec<(String, String)> = ask
            .query
            .iter()
            .filter(|(known, _)| known != name)
            .cloned()
            .collect();
        query.push((name.to_owned(), value));
        Ask {
            url: ask.url.clone(),
            query,
        }
    }

    fn stuck(call: &str, what: &str) -> Error {
        Error::Pagination(format!(
            "{call}: the server answered with the {what} it was asked for; there is no next page \
             to ask for"
        ))
    }

    /// The URL of a next page, which has to be on the origin of the page
    /// that names it: what the client sends with a request goes with it.
    fn same_origin(call: &str, current: &str, next: &str) -> Result<String, Error> {
        let unreadable =
            |error| Error::Pagination(format!("{call}: the URL of the next page: {error}"));
        let current = Url::parse(current).map_err(unreadable)?;
        let resolved = current.join(next).map_err(unreadable)?;
        if resolved.origin() != current.origin() {
            return Err(Error::Pagination(format!(
                "{call}: the next page is on another origin ({resolved}); it is not followed"
            )));
        }
        Ok(resolved.into())
    }

    /// The page after one that names its cursor.
    fn after_cursor(
        call: &str,
        page: &Value,
        ask: &Ask,
        cursor: &str,
        cursor_param: &str,
    ) -> Result<Option<Ask>, Error> {
        let Some(next) = at(page, cursor)
            .and_then(text)
            .filter(|next| !next.is_empty())
        else {
            return Ok(None);
        };
        if param(&ask.query, cursor_param) == Some(next.as_str()) {
            return Err(stuck(call, "cursor"));
        }
        Ok(Some(with(ask, cursor_param, next)))
    }

    /// The page after the last item of one.
    fn after_item(
        call: &str,
        found: &[Value],
        ask: &Ask,
        id_field: &str,
        cursor_id_param: &str,
        limit_param: Option<&str>,
    ) -> Result<Option<Ask>, Error> {
        let Some(last) = found.last() else {
            return Ok(None);
        };
        // A page shorter than the size asked for is the last one.
        let limit = limit_param.and_then(|name| count_of(&ask.query, name));
        if limit.is_some_and(|limit| count(found) < limit) {
            return Ok(None);
        }
        let Some(id) = at(last, id_field).and_then(text) else {
            return Err(Error::Pagination(format!(
                "{call}: the last item of the page has no {id_field:?} to continue from"
            )));
        };
        if param(&ask.query, cursor_id_param) == Some(id.as_str()) {
            return Err(stuck(call, "item"));
        }
        Ok(Some(with(ask, cursor_id_param, id)))
    }

    /// The page after the items seen so far.
    fn after_offset(
        page: &Value,
        found: &[Value],
        ask: &Ask,
        total: &str,
        offset_param: &str,
    ) -> Option<Ask> {
        if found.is_empty() {
            return None;
        }
        let offset = count_of(&ask.query, offset_param)
            .unwrap_or(0)
            .saturating_add(count(found));
        let total = at(page, total).and_then(Value::as_u64);
        if total.is_some_and(|total| offset >= total) {
            return None;
        }
        Some(with(ask, offset_param, offset.to_string()))
    }

    /// The page with the next number, unless this one is the last: by the
    /// number of pages, by the total, or because it is short or empty.
    fn after_page(
        page: &Value,
        found: &[Value],
        ask: &Ask,
        page_size: usize,
        (total, total_pages): (Option<&str>, Option<&str>),
        (page_param, per_page_param): (&str, Option<&str>),
    ) -> Option<Ask> {
        let current = count_of(&ask.query, page_param).unwrap_or(1);
        let size = per_page_param
            .and_then(|name| count_of(&ask.query, name))
            .filter(|size| *size > 0)
            .unwrap_or(u64::try_from(page_size).unwrap_or(u64::MAX));
        let number = |field: Option<&str>| {
            field
                .and_then(|field| at(page, field))
                .and_then(Value::as_u64)
        };
        let seen = current
            .saturating_sub(1)
            .saturating_mul(size)
            .saturating_add(count(found));
        let last = found.is_empty()
            || count(found) < size
            || number(total_pages).is_some_and(|pages| current >= pages)
            || number(total).is_some_and(|total| seen >= total);
        if last {
            return None;
        }
        Some(with(ask, page_param, current.saturating_add(1).to_string()))
    }

    /// The number of items of a page.
    fn count(found: &[Value]) -> u64 {
        u64::try_from(found.len()).unwrap_or(u64::MAX)
    }

    /// Where the page after a page is, or nothing after the last one.
    ///
    /// The last argument is the size of a page where the query does not
    /// say: the number of items of the first one.
    pub(super) fn next_page(
        call: &str,
        meta: &Pagination,
        page: &Value,
        ask: &Ask,
        page_size: usize,
    ) -> Result<Option<Ask>, Error> {
        let found = items(page, meta);
        match *meta {
            Pagination::Cursor {
                cursor,
                cursor_param,
                ..
            } => after_cursor(call, page, ask, cursor, cursor_param),
            Pagination::CursorId {
                id_field,
                cursor_id_param,
                limit_param,
                ..
            } => after_item(call, found, ask, id_field, cursor_id_param, limit_param),
            Pagination::Offset {
                total,
                offset_param,
                ..
            } => Ok(after_offset(page, found, ask, total, offset_param)),
            Pagination::Page {
                total,
                total_pages,
                page_param,
                per_page_param,
                ..
            } => Ok(after_page(
                page,
                found,
                ask,
                page_size,
                (total, total_pages),
                (page_param, per_page_param),
            )),
            Pagination::Url { next_url, .. } => {
                let Some(next) = at(page, next_url)
                    .and_then(Value::as_str)
                    .filter(|next| !next.is_empty())
                else {
                    return Ok(None);
                };
                Ok(Some(Ask {
                    url: same_origin(call, &ask.url, next)?,
                    query: Vec::new(),
                }))
            }
        }
    }

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// Reads a member that may be absent and whose type has a value for
    /// null of its own: a null that is there is that value, not an absent
    /// member.
    pub(super) fn present_member<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        T: Deserialize<'de>,
        D: serde::Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Some)
    }

    /// A default the contract gives as JSON, as the type of its member.
    pub(super) fn default_value<T: DeserializeOwned>(json: &str) -> T {
        serde_json::from_str(json).expect("a generated default fits its type")
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        // Every name of the module: a list of them is sorted differently
        // by each style edition of rustfmt.
        use super::*;

        fn ask(query: &[(&str, &str)]) -> Ask {
            Ask {
                url: "http://api/v1/items".to_owned(),
                query: query
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect(),
            }
        }

        /// The query of the next page, or nothing after the last one.
        fn step(
            meta: &Pagination,
            page: &Value,
            query: &[(&str, &str)],
            page_size: usize,
        ) -> Option<Vec<(String, String)>> {
            next_page("list", meta, page, &ask(query), page_size)
                .expect("the next page can be found")
                .map(|next| next.query)
        }

        fn pair(name: &str, value: &str) -> (String, String) {
            (name.to_owned(), value.to_owned())
        }

        #[test]
        fn a_path_parameter_is_one_segment() {
            assert_eq!(segment("a b/c?d").unwrap(), "a%20b%2Fc%3Fd");
            assert_eq!(segment("v1.2").unwrap(), "v1.2");
            assert_eq!(rest("docs/a b.txt").unwrap(), "docs/a%20b.txt");
            for value in ["", ".", ".."] {
                assert!(
                    matches!(segment(value), Err(Error::Request(_))),
                    "{value:?}"
                );
            }
            for value in ["../../admin", "a/./b", "a/.."] {
                assert!(matches!(rest(value), Err(Error::Request(_))), "{value:?}");
            }
        }

        #[test]
        fn a_query_is_pairs_and_a_list_repeats_its_name() {
            let query = json!({ "limit": 2, "tag": ["a", "b"], "cursor": null, "open": true });
            assert_eq!(
                pairs(&query).unwrap(),
                [
                    pair("limit", "2"),
                    pair("open", "true"),
                    pair("tag", "a"),
                    pair("tag", "b")
                ]
            );
            assert!(pairs(&json!({ "filter": { "a": 1 } })).is_err());
        }

        #[test]
        fn a_cursor_is_followed_until_there_is_none() {
            let meta = Pagination::Cursor {
                items: "items",
                cursor: "next",
                cursor_param: "after",
            };
            let page = json!({ "items": [1, 2], "next": "c2" });
            assert_eq!(
                step(&meta, &page, &[("limit", "2")], 2),
                Some(vec![pair("limit", "2"), pair("after", "c2")])
            );
            assert_eq!(step(&meta, &json!({ "items": [3] }), &[], 2), None);
            assert_eq!(
                step(&meta, &json!({ "items": [3], "next": "" }), &[], 2),
                None
            );
            // The cursor that was asked with: the list would never end.
            let again = next_page("list", &meta, &page, &ask(&[("after", "c2")]), 2);
            assert!(matches!(again, Err(Error::Pagination(_))));
        }

        #[test]
        fn the_id_of_the_last_item_is_the_next_cursor() {
            let meta = Pagination::CursorId {
                items: "items",
                id_field: "id",
                cursor_id_param: "after",
                limit_param: Some("limit"),
            };
            let page = json!({ "items": [{ "id": 7 }, { "id": 8 }] });
            assert_eq!(
                step(&meta, &page, &[("limit", "2")], 2),
                Some(vec![pair("limit", "2"), pair("after", "8")])
            );
            // Shorter than the size asked for, and empty: the last page.
            assert_eq!(step(&meta, &page, &[("limit", "3")], 2), None);
            assert_eq!(step(&meta, &json!({ "items": [] }), &[], 2), None);
            let nameless = json!({ "items": [{ "name": "x" }] });
            assert!(next_page("list", &meta, &nameless, &ask(&[]), 1).is_err());
        }

        #[test]
        fn an_offset_grows_by_the_items_seen() {
            let meta = Pagination::Offset {
                items: "items",
                total: "total",
                offset_param: "offset",
            };
            let page = json!({ "items": [1, 2], "total": 5 });
            assert_eq!(step(&meta, &page, &[], 2), Some(vec![pair("offset", "2")]));
            assert_eq!(
                step(&meta, &page, &[("offset", "2")], 2),
                Some(vec![pair("offset", "4")])
            );
            assert_eq!(step(&meta, &page, &[("offset", "3")], 2), None);
            assert_eq!(step(&meta, &json!({ "items": [] }), &[], 2), None);
        }

        #[test]
        fn a_page_number_ends_with_the_count_the_total_or_a_short_page() {
            let meta = Pagination::Page {
                items: "items",
                total: Some("total"),
                total_pages: Some("pages"),
                page_param: "page",
                per_page_param: Some("perPage"),
            };
            let full = json!({ "items": [1, 2] });
            assert_eq!(step(&meta, &full, &[], 2), Some(vec![pair("page", "2")]));
            assert_eq!(
                step(&meta, &json!({ "items": [1, 2], "pages": 1 }), &[], 2),
                None
            );
            assert_eq!(
                step(
                    &meta,
                    &json!({ "items": [3, 4], "total": 4 }),
                    &[("page", "2")],
                    2
                ),
                None
            );
            assert_eq!(step(&meta, &json!({ "items": [1] }), &[], 2), None);
            // An empty page ends the list, also the first one.
            assert_eq!(
                step(&meta, &json!({ "items": [] }), &[("page", "3")], 2),
                None
            );
            assert_eq!(step(&meta, &json!({ "items": [] }), &[], 0), None);
            // The first page gives the size when the query does not.
            assert_eq!(step(&meta, &full, &[], 3), None);
        }

        #[test]
        fn a_next_url_is_followed_on_the_same_origin_only() {
            let meta = Pagination::Url {
                items: "items",
                next_url: "links.next",
            };
            let next = |url: &str| {
                let page = json!({ "items": [1], "links": { "next": url } });
                next_page("list", &meta, &page, &ask(&[("limit", "1")]), 1)
            };
            // A relative URL is resolved against the page that names it.
            assert_eq!(
                next("?page=2").unwrap().map(|next| next.url).as_deref(),
                Some("http://api/v1/items?page=2")
            );
            // The port a scheme has anyway is the same origin.
            assert!(next("http://api:80/v1/items?page=2").unwrap().is_some());
            assert!(matches!(
                next("http://elsewhere/items?page=2"),
                Err(Error::Pagination(_))
            ));
            assert_eq!(step(&meta, &json!({ "items": [1] }), &[], 1), None);
        }
    }
}
`.trim();
