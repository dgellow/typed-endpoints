//! The OAuth 2.0 authorization code protocol of `src/protocol/oauth.ts`,
//! as a session whose states are values that are moved.
//!
//! Written by hand, to find out what a generator would have to write. In
//! TypeScript a session is checked in two layers: the types track which
//! steps are done, and that a state is used once is a runtime option,
//! because a TypeScript value can always be used twice. Here a step takes
//! the session by value and gives back the state that follows, so the
//! state before it is gone.
//!
//! `fuzzProtocol()` sends an executor four kinds of calls that the
//! protocol forbids. With this session none of them is a call that
//! compiles. Each example below is one of them, and does not build: its
//! fence names the error the compiler gives. rustdoc checks that only on
//! a nightly toolchain, so `./scripts/test-rust` builds each example by
//! itself and looks for that error and no other
//! (`e2e_tests/rust/forbidden_calls.ts`).
//!
//! A step before the step it depends on (`before-dependency`). There is
//! no such method on the state:
//!
//! ```compile_fail,E0599
//! use typed_endpoints_rust_e2e::oauth_session::{Client, Server, Session};
//!
//! async fn forbidden<S: Server>(server: S, client: Client) {
//!     let session = Session::new(server, client);
//!     session.exchange().await;
//! }
//! ```
//!
//! A step after a response it does not follow (`wrong-variant`). The
//! authorization was denied, and what comes back is the start:
//!
//! ```compile_fail,E0599
//! use typed_endpoints_rust_e2e::oauth_session::{Authorization, Client, Server, Session};
//!
//! async fn forbidden<S: Server>(server: S, client: Client) {
//!     let session = Session::new(server, client);
//!     if let Ok(Authorization::Denied(session, _)) = session.authorize("state", None).await {
//!         session.exchange().await;
//!     }
//! }
//! ```
//!
//! A step whose dependency was revoked (`revoked`). The exchange spends
//! the authorization, which was moved into it:
//!
//! ```compile_fail,E0382
//! use typed_endpoints_rust_e2e::oauth_session::{Authorization, Client, Server, Session};
//!
//! async fn forbidden<S: Server>(server: S, client: Client) {
//!     let session = Session::new(server, client);
//!     if let Ok(Authorization::Granted(authorized)) = session.authorize("state", None).await {
//!         let _first = authorized.exchange().await;
//!         let _again = authorized.exchange().await;
//!     }
//! }
//! ```
//!
//! A request built for another response (`forged`). The code is not an
//! argument of the exchange, and a state that holds one cannot be made
//! outside this module:
//!
//! ```compile_fail,E0451
//! use typed_endpoints_rust_e2e::oauth_session::{Authorized, Client, Server, Session};
//!
//! fn forbidden<S: Server>(server: S, client: Client) -> Session<S, Authorized> {
//!     Session { server, client, state: Authorized { code: "stolen".to_owned() } }
//! }
//! ```
//!
//! What is allowed builds:
//!
//! ```no_run
//! use typed_endpoints_rust_e2e::oauth_session::{
//!     Authorization, Client, Exchange, Refresh, Server, Session,
//! };
//!
//! async fn allowed<S: Server>(server: S, client: Client) -> Result<(), S::Error> {
//!     let session = Session::new(server, client);
//!     let Authorization::Granted(authorized) = session.authorize("state", None).await? else {
//!         return Ok(());
//!     };
//!     let Exchange::Renewable(granted) = authorized.exchange().await? else {
//!         return Ok(());
//!     };
//!     let granted = match granted.refresh(None).await? {
//!         Refresh::Renewed(granted) | Refresh::Refused(granted, _) => granted,
//!     };
//!     granted.revoke().await
//! }
//! ```

use std::future::Future;

/// What a client is registered as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

/// What the authorization endpoint is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizeRequest {
    pub client_id: String,
    pub state: String,
    pub scope: Option<String>,
}

/// What the authorization endpoint answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizeResponse {
    Success { code: String, state: String },
    Error { error: String },
}

/// What the token endpoint is asked for a code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeRequest {
    pub code: String,
    pub client_id: String,
    pub client_secret: String,
}

/// What the token endpoint is asked for a refresh token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRequest {
    pub refresh_token: String,
    pub client_id: String,
    pub scope: Option<String>,
}

/// What the revocation endpoint is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokeRequest {
    pub token: String,
    pub client_id: String,
}

/// The tokens of a grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
}

/// What the token endpoint answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenResponse {
    Success(Tokens),
    Error { error: String },
}

/// Whatever performs the steps: an HTTP client, a test double.
pub trait Server {
    /// A step that got no answer.
    type Error;

    fn authorize(
        &self,
        request: AuthorizeRequest,
    ) -> impl Future<Output = Result<AuthorizeResponse, Self::Error>>;

    fn exchange(
        &self,
        request: ExchangeRequest,
    ) -> impl Future<Output = Result<TokenResponse, Self::Error>>;

    fn refresh(
        &self,
        request: RefreshRequest,
    ) -> impl Future<Output = Result<TokenResponse, Self::Error>>;

    fn revoke(&self, request: RevokeRequest) -> impl Future<Output = Result<(), Self::Error>>;
}

/// A run of the protocol, in the state `State`.
///
/// A step is a method of the states it may follow. It takes the session
/// and gives back the session in the state that follows.
#[derive(Debug)]
pub struct Session<S, State> {
    server: S,
    client: Client,
    state: State,
}

/// No step has run, or the last one led back here.
#[derive(Debug)]
pub struct Start;

/// The authorization was granted: there is a code, to be exchanged once.
#[derive(Debug)]
pub struct Authorized {
    code: String,
}

/// The exchange gave an access token and no refresh token.
#[derive(Debug)]
pub struct Access {
    tokens: Tokens,
}

/// The exchange, or the last refresh, gave an access token and the
/// refresh token to use next.
#[derive(Debug)]
pub struct Renewable {
    tokens: Tokens,
    refresh_token: String,
}

/// What the authorization led to.
#[derive(Debug)]
pub enum Authorization<S> {
    Granted(Session<S, Authorized>),
    /// With the reason. The session is at its start.
    Denied(Session<S, Start>, String),
}

/// What the exchange led to. The code is spent either way.
#[derive(Debug)]
pub enum Exchange<S> {
    Renewable(Session<S, Renewable>),
    Access(Session<S, Access>),
    /// With the reason. The session is at its start.
    Refused(Session<S, Start>, String),
}

/// What a refresh led to.
#[derive(Debug)]
pub enum Refresh<S> {
    /// The tokens are the new ones; the refresh token that was used is gone.
    Renewed(Session<S, Renewable>),
    /// With the reason. The tokens are the ones before.
    Refused(Session<S, Renewable>, String),
}

impl<S: Server> Session<S, Start> {
    /// A session that has done nothing yet.
    pub fn new(server: S, client: Client) -> Self {
        Self {
            server,
            client,
            state: Start,
        }
    }

    /// Asks for the authorization.
    ///
    /// # Errors
    ///
    /// The server's, when the step got no answer. The session is gone then.
    pub async fn authorize(
        self,
        state: &str,
        scope: Option<String>,
    ) -> Result<Authorization<S>, S::Error> {
        let request = AuthorizeRequest {
            client_id: self.client.id.clone(),
            state: state.to_owned(),
            scope,
        };
        Ok(match self.server.authorize(request).await? {
            AuthorizeResponse::Success { code, .. } => Authorization::Granted(Session {
                server: self.server,
                client: self.client,
                state: Authorized { code },
            }),
            AuthorizeResponse::Error { error } => Authorization::Denied(self, error),
        })
    }
}

impl<S: Server> Session<S, Authorized> {
    /// Exchanges the code for tokens. The code is the one the
    /// authorization gave: it is not an argument.
    ///
    /// # Errors
    ///
    /// The server's, when the step got no answer. The session is gone then.
    pub async fn exchange(self) -> Result<Exchange<S>, S::Error> {
        let Self {
            server,
            client,
            state,
        } = self;
        let request = ExchangeRequest {
            code: state.code,
            client_id: client.id.clone(),
            client_secret: client.secret.clone(),
        };
        Ok(match server.exchange(request).await? {
            TokenResponse::Success(mut tokens) => match tokens.refresh_token.take() {
                Some(refresh_token) => Exchange::Renewable(Session {
                    server,
                    client,
                    state: Renewable {
                        tokens,
                        refresh_token,
                    },
                }),
                None => Exchange::Access(Session {
                    server,
                    client,
                    state: Access { tokens },
                }),
            },
            TokenResponse::Error { error } => Exchange::Refused(
                Session {
                    server,
                    client,
                    state: Start,
                },
                error,
            ),
        })
    }
}

impl<S: Server> Session<S, Access> {
    /// The access token.
    #[must_use]
    pub fn access_token(&self) -> &str {
        &self.state.tokens.access_token
    }

    /// Revokes the access token and ends the session.
    ///
    /// # Errors
    ///
    /// The server's, when the step got no answer.
    pub async fn revoke(self) -> Result<(), S::Error> {
        let request = RevokeRequest {
            token: self.state.tokens.access_token,
            client_id: self.client.id,
        };
        self.server.revoke(request).await
    }
}

impl<S: Server> Session<S, Renewable> {
    /// The access token.
    #[must_use]
    pub fn access_token(&self) -> &str {
        &self.state.tokens.access_token
    }

    /// Asks for new tokens with the refresh token, which is the current
    /// one: it is not an argument.
    ///
    /// # Errors
    ///
    /// The server's, when the step got no answer. The session is gone then.
    pub async fn refresh(self, scope: Option<String>) -> Result<Refresh<S>, S::Error> {
        let request = RefreshRequest {
            refresh_token: self.state.refresh_token.clone(),
            client_id: self.client.id.clone(),
            scope,
        };
        Ok(match self.server.refresh(request).await? {
            TokenResponse::Success(mut tokens) => {
                // A server that rotates gives a new refresh token; one that
                // does not leaves the one that was used in force.
                let refresh_token = tokens
                    .refresh_token
                    .take()
                    .unwrap_or(self.state.refresh_token);
                Refresh::Renewed(Session {
                    server: self.server,
                    client: self.client,
                    state: Renewable {
                        tokens,
                        refresh_token,
                    },
                })
            }
            TokenResponse::Error { error } => Refresh::Refused(self, error),
        })
    }

    /// Revokes the refresh token, and the access token with it, and ends
    /// the session.
    ///
    /// # Errors
    ///
    /// The server's, when the step got no answer.
    pub async fn revoke(self) -> Result<(), S::Error> {
        let request = RevokeRequest {
            token: self.state.refresh_token,
            client_id: self.client.id,
        };
        self.server.revoke(request).await
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::future::ready;

    use super::*;

    /// A server that answers what it was told to, and keeps what it was
    /// asked.
    #[derive(Default)]
    struct Scripted {
        authorizations: RefCell<VecDeque<AuthorizeResponse>>,
        tokens: RefCell<VecDeque<TokenResponse>>,
        asked: RefCell<Vec<String>>,
    }

    impl Server for &Scripted {
        type Error = &'static str;

        fn authorize(
            &self,
            request: AuthorizeRequest,
        ) -> impl Future<Output = Result<AuthorizeResponse, Self::Error>> {
            self.note(format!("authorize {}", request.state));
            let answer = self.authorizations.borrow_mut().pop_front();
            ready(answer.ok_or("no authorization left"))
        }

        fn exchange(
            &self,
            request: ExchangeRequest,
        ) -> impl Future<Output = Result<TokenResponse, Self::Error>> {
            self.note(format!("exchange {}", request.code));
            ready(self.tokens.borrow_mut().pop_front().ok_or("no tokens left"))
        }

        fn refresh(
            &self,
            request: RefreshRequest,
        ) -> impl Future<Output = Result<TokenResponse, Self::Error>> {
            self.note(format!("refresh {}", request.refresh_token));
            ready(self.tokens.borrow_mut().pop_front().ok_or("no tokens left"))
        }

        fn revoke(&self, request: RevokeRequest) -> impl Future<Output = Result<(), Self::Error>> {
            self.note(format!("revoke {}", request.token));
            ready(Ok(()))
        }
    }

    impl Scripted {
        fn note(&self, asked: String) {
            self.asked.borrow_mut().push(asked);
        }
    }

    fn client() -> Client {
        Client {
            id: "app".to_owned(),
            secret: "secret".to_owned(),
        }
    }

    fn tokens(access: &str, refresh: Option<&str>) -> TokenResponse {
        TokenResponse::Success(Tokens {
            access_token: access.to_owned(),
            expires_in: 3600,
            refresh_token: refresh.map(str::to_owned),
            scope: None,
        })
    }

    fn granted(code: &str) -> AuthorizeResponse {
        AuthorizeResponse::Success {
            code: code.to_owned(),
            state: "s".to_owned(),
        }
    }

    #[tokio::test]
    async fn the_session_fills_in_what_an_earlier_response_gave() {
        let server = Scripted::default();
        server.authorizations.borrow_mut().push_back(granted("c1"));
        server.tokens.borrow_mut().extend([
            tokens("a1", Some("r1")),
            // A server that rotates the refresh token.
            tokens("a2", Some("r2")),
            // One that does not: the token that was used stays in force.
            tokens("a3", None),
        ]);

        let session = Session::new(&server, client());
        let Ok(Authorization::Granted(authorized)) = session.authorize("s", None).await else {
            panic!("the authorization is granted");
        };
        let Ok(Exchange::Renewable(session)) = authorized.exchange().await else {
            panic!("the exchange gives a refresh token");
        };
        assert_eq!(session.access_token(), "a1");
        let Ok(Refresh::Renewed(session)) = session.refresh(None).await else {
            panic!("the first refresh is answered");
        };
        let Ok(Refresh::Renewed(session)) = session.refresh(None).await else {
            panic!("the second refresh is answered");
        };
        assert_eq!(session.access_token(), "a3");
        session.revoke().await.expect("the revocation is answered");

        assert_eq!(
            *server.asked.borrow(),
            [
                "authorize s",
                "exchange c1",
                "refresh r1",
                "refresh r2",
                "revoke r2"
            ]
        );
    }

    #[tokio::test]
    async fn a_step_that_is_refused_gives_back_the_state_it_leaves() {
        let server = Scripted::default();
        server.authorizations.borrow_mut().extend([
            AuthorizeResponse::Error {
                error: "access_denied".to_owned(),
            },
            granted("c2"),
        ]);
        server.tokens.borrow_mut().extend([TokenResponse::Error {
            error: "invalid_grant".to_owned(),
        }]);

        // Denied: the session is at its start, and may ask again.
        let session = Session::new(&server, client());
        let Ok(Authorization::Denied(session, reason)) = session.authorize("first", None).await
        else {
            panic!("the first authorization is denied");
        };
        assert_eq!(reason, "access_denied");
        let Ok(Authorization::Granted(authorized)) = session.authorize("second", None).await else {
            panic!("the second authorization is granted");
        };

        // A refused exchange has spent the code all the same: the start again.
        let Ok(Exchange::Refused(_start, reason)) = authorized.exchange().await else {
            panic!("the exchange is refused");
        };
        assert_eq!(reason, "invalid_grant");
        assert_eq!(
            *server.asked.borrow(),
            ["authorize first", "authorize second", "exchange c2"]
        );
    }

    #[tokio::test]
    async fn without_a_refresh_token_there_is_no_refresh() {
        let server = Scripted::default();
        server.authorizations.borrow_mut().push_back(granted("c3"));
        server.tokens.borrow_mut().push_back(tokens("a1", None));

        let session = Session::new(&server, client());
        let Ok(Authorization::Granted(authorized)) = session.authorize("s", None).await else {
            panic!("the authorization is granted");
        };
        // The state has an access token and no `refresh` method.
        let Ok(Exchange::Access(session)) = authorized.exchange().await else {
            panic!("the exchange gives no refresh token");
        };
        session.revoke().await.expect("the revocation is answered");
        assert_eq!(
            server.asked.borrow().last().map(String::as_str),
            Some("revoke a1")
        );
    }
}
