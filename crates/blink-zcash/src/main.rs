//! HTTP service exposing the BLINK Zcash engine.
//!
//! The Node API calls this service to get an authoritative answer on Zcash
//! addresses and ZIP 321 URIs. The service is intentionally stateless and holds
//! no keys, no funds and no user data: it only decodes public encodings.
//!
//! Endpoints
//! ---------
//! * `GET  /health`            — liveness probe.
//! * `POST /v1/address/inspect`— classify and validate an address.
//! * `POST /v1/zip321/build`   — build a ZIP 321 URI from validated payments.
//! * `POST /v1/zip321/parse`   — parse and validate a ZIP 321 URI.

use std::net::SocketAddr;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use blink_zcash::{BlinkNetwork, Error, PaymentSpec};

#[derive(Clone)]
struct AppState {
    network: BlinkNetwork,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
    kind: &'static str,
}

/// Newtype so we can implement `IntoResponse` for the library error (the orphan
/// rule forbids implementing a foreign trait for a foreign type directly).
struct ApiError(Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let err = self.0;
        let kind = match err {
            Error::InvalidNetwork(_) => "invalid_network",
            Error::AddressParse(_) => "invalid_address",
            Error::SproutUnsupported => "unsupported_sprout",
            Error::NetworkMismatch { .. } => "network_mismatch",
            Error::InvalidAmount(_) => "invalid_amount",
            Error::InvalidMemo(_) => "invalid_memo",
            Error::Zip321(_) => "invalid_zip321",
            Error::Payment(_) => "invalid_payment",
        };
        let status = match err {
            Error::InvalidNetwork(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        (
            status,
            Json(ErrorBody {
                error: err.to_string(),
                kind,
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Deserialize)]
struct InspectRequest {
    address: String,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Debug, Serialize)]
struct InspectResponse {
    address: String,
    kind: String,
    network: String,
    can_receive_memo: bool,
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "blink-zcash" }))
}

async fn inspect(
    State(state): State<AppState>,
    Json(req): Json<InspectRequest>,
) -> Result<Json<InspectResponse>, ApiError> {
    let network = match req.network {
        Some(n) => BlinkNetwork::parse(&n)?,
        None => state.network,
    };
    let info = blink_zcash::validate_address(&req.address, network)?;
    Ok(Json(InspectResponse {
        address: info.address,
        kind: format!("{:?}", info.kind).to_lowercase(),
        network: info.network.as_str().to_string(),
        can_receive_memo: info.can_receive_memo,
    }))
}

#[derive(Debug, Deserialize)]
struct BuildRequest {
    payments: Vec<PaymentSpec>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Debug, Serialize)]
struct BuildResponse {
    uri: String,
}

async fn build(
    State(state): State<AppState>,
    Json(req): Json<BuildRequest>,
) -> Result<Json<BuildResponse>, ApiError> {
    let network = match req.network {
        Some(n) => BlinkNetwork::parse(&n)?,
        None => state.network,
    };
    let uri = blink_zcash::build_uri(&req.payments, network)?;
    Ok(Json(BuildResponse { uri }))
}

#[derive(Debug, Deserialize)]
struct ParseRequest {
    uri: String,
    #[serde(default)]
    network: Option<String>,
}

async fn parse(
    State(state): State<AppState>,
    Json(req): Json<ParseRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let network = match req.network {
        Some(n) => Some(BlinkNetwork::parse(&n)?),
        None => Some(state.network),
    };
    let payments = blink_zcash::parse_uri(&req.uri, network)?;
    Ok(Json(serde_json::json!({ "payments": payments })))
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/address/inspect", post(inspect))
        .route("/v1/zip321/build", post(build))
        .route("/v1/zip321/parse", post(parse))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let network = match std::env::var("ZCASH_NETWORK") {
        Ok(n) => BlinkNetwork::parse(&n).unwrap_or_else(|e| {
            warn!("{e}; defaulting to testnet");
            BlinkNetwork::Testnet
        }),
        Err(_) => BlinkNetwork::Testnet,
    };

    let host = std::env::var("BLINK_ZCASH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("BLINK_ZCASH_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("invalid bind address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind failed");
    info!(%addr, network = network.as_str(), "blink-zcash service listening");

    axum::serve(listener, app(AppState { network }))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down");
}
