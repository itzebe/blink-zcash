//! Authoritative Zcash engine for BLINK.
//!
//! BLINK does not reimplement Zcash address encoding or ZIP 321. This crate is a
//! thin, well-tested wrapper around the official Zcash Rust crates:
//!
//! * [`zcash_address`] — parsing and encoding of transparent, Sapling and
//!   Unified Addresses (and explicit rejection of Sprout).
//! * [`zip321`] — generation and parsing of ZIP 321 payment request URIs.
//! * [`zcash_protocol`] — `Zatoshis` and `MemoBytes` value types.
//!
//! The TypeScript packages in `packages/payment-request` and `packages/zcash`
//! provide a fast structural check used by the web client and for early request
//! validation. This crate is the authoritative check: when the API is configured
//! with a `BLINK_ZCASH_SERVICE_URL`, every address and URI is confirmed here
//! before it is accepted or returned.

use std::fmt;
use std::io::Cursor;

use serde::{Deserialize, Serialize};
use zcash_address::{unified, unified::Container, ConversionError, TryFromAddress, ZcashAddress};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BranchId, NetworkType},
    memo::MemoBytes,
    value::Zatoshis,
    PoolType,
};
use zcash_transparent::address::TransparentAddress;
use zip321::{Payment, TransactionRequest};

pub const ZATOSHIS_PER_ZEC: u64 = 100_000_000;
pub const MAX_ZEC: u64 = 21_000_000;
pub const MAX_MEMO_BYTES: usize = 512;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Debug)]
pub enum Error {
    InvalidNetwork(String),
    AddressParse(String),
    SproutUnsupported,
    NetworkMismatch { expected: String, actual: String },
    InvalidAmount(String),
    InvalidMemo(String),
    Zip321(String),
    Payment(String),
    Transaction(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidNetwork(n) => write!(f, "invalid network: {n}"),
            Error::AddressParse(e) => write!(f, "invalid address: {e}"),
            Error::SproutUnsupported => {
                write!(
                    f,
                    "Sprout addresses are not supported in payment requests (ZIP 321)"
                )
            }
            Error::NetworkMismatch { expected, actual } => {
                write!(f, "address is for {actual} but {expected} was expected")
            }
            Error::InvalidAmount(e) => write!(f, "invalid amount: {e}"),
            Error::InvalidMemo(e) => write!(f, "invalid memo: {e}"),
            Error::Zip321(e) => write!(f, "invalid ZIP 321 payment request: {e}"),
            Error::Payment(e) => write!(f, "invalid payment: {e}"),
            Error::Transaction(e) => write!(f, "invalid transaction: {e}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/* -------------------------------------------------------------------------- */
/* Networks                                                                   */
/* -------------------------------------------------------------------------- */

/// The networks BLINK supports. Mainnet must be selected explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlinkNetwork {
    Testnet,
    Mainnet,
}

impl BlinkNetwork {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "testnet" | "test" => Ok(BlinkNetwork::Testnet),
            "mainnet" | "main" => Ok(BlinkNetwork::Mainnet),
            other => Err(Error::InvalidNetwork(other.to_string())),
        }
    }

    pub fn to_network_type(self) -> NetworkType {
        match self {
            BlinkNetwork::Testnet => NetworkType::Test,
            BlinkNetwork::Mainnet => NetworkType::Main,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BlinkNetwork::Testnet => "testnet",
            BlinkNetwork::Mainnet => "mainnet",
        }
    }
}

impl fmt::Display for BlinkNetwork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

fn network_type_to_blink(net: NetworkType) -> BlinkNetwork {
    match net {
        NetworkType::Main => BlinkNetwork::Mainnet,
        // Regtest shares testnet address encodings; treat it as testnet.
        NetworkType::Test | NetworkType::Regtest => BlinkNetwork::Testnet,
    }
}

/* -------------------------------------------------------------------------- */
/* Address classification                                                     */
/* -------------------------------------------------------------------------- */

/// The pool an address belongs to, as far as BLINK is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    Transparent,
    Sapling,
    Unified,
}

/// The receiver pools actually present in an address.
///
/// For a non-Unified address this is derived from the address type itself. For a
/// Unified Address it is derived by inspecting the parsed receiver list — never
/// from the address prefix — so a Unified Address that exposes only a transparent
/// receiver is reported truthfully as transparent-capable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiverPools {
    /// A P2PKH or P2SH receiver/output is present.
    pub transparent: bool,
    /// A Sapling receiver is present.
    pub sapling: bool,
    /// An Orchard receiver is present.
    pub orchard: bool,
    /// Whether this address can receive a shielded (Sapling or Orchard) transfer.
    pub shielded: bool,
    /// Whether the only recognized receivers are transparent ones.
    pub transparent_only: bool,
    /// A receiver of a type this build does not recognise is present. The pool
    /// composition cannot be fully determined, so the capability must not be
    /// claimed. A Unified Address with an unknown receiver and no known shielded
    /// receiver is treated as not confirmably shielded.
    pub unknown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddressInfo {
    pub address: String,
    pub kind: AddressKind,
    pub network: BlinkNetwork,
    pub can_receive_memo: bool,
    /// The receiver pools actually present in this address.
    pub receivers: ReceiverPools,
}

/// The receiver composition of a Unified Address derived from its parsed items.
fn unified_receiver_pools(ua: &unified::Address) -> ReceiverPools {
    let transparent = ua.has_receiver_of_type(PoolType::TRANSPARENT);
    let sapling = ua.has_receiver_of_type(PoolType::SAPLING);
    let orchard = ua.has_receiver_of_type(PoolType::ORCHARD);
    let unknown = ua
        .items()
        .iter()
        .any(|item| matches!(item, unified::Receiver::Unknown { .. }));
    ReceiverPools {
        transparent,
        sapling,
        orchard,
        shielded: sapling || orchard,
        transparent_only: transparent && !(sapling || orchard),
        unknown,
    }
}

/// A classifier used with [`ZcashAddress::convert`]. The default trait methods
/// reject Sprout addresses, which is exactly the ZIP 321 requirement. The tuple
/// conversion lets us recover the network, the address kind, and — for a Unified
/// Address — the actual receiver pools from a single parse.
#[derive(Debug, Clone, Copy)]
pub struct Classified {
    pub network: BlinkNetwork,
    pub kind: AddressKind,
    /// Present and meaningful only for a Unified Address.
    pub unif: Option<ReceiverPools>,
}

impl TryFromAddress for Classified {
    type Error = std::convert::Infallible;

    fn try_from_sapling(
        net: NetworkType,
        _data: [u8; 43],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Sapling,
            unif: None,
        })
    }

    fn try_from_unified(
        net: NetworkType,
        data: unified::Address,
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        let unif = unified_receiver_pools(&data);
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Unified,
            unif: Some(unif),
        })
    }

    fn try_from_transparent_p2pkh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Transparent,
            unif: None,
        })
    }

    fn try_from_transparent_p2sh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Transparent,
            unif: None,
        })
    }
}

/// Parse and classify a Zcash address using the official crate.
pub fn inspect_address(address: &str) -> Result<AddressInfo> {
    let parsed =
        ZcashAddress::try_from_encoded(address).map_err(|e| Error::AddressParse(e.to_string()))?;
    let classified = parsed
        .clone()
        .convert::<Classified>()
        .map_err(map_conversion_error)?;
    let receivers = match (classified.kind, classified.unif) {
        (AddressKind::Unified, Some(pools)) => pools,
        (AddressKind::Sapling, _) => ReceiverPools {
            transparent: false,
            sapling: true,
            orchard: false,
            shielded: true,
            transparent_only: false,
            unknown: false,
        },
        (AddressKind::Transparent, _) => ReceiverPools {
            transparent: true,
            sapling: false,
            orchard: false,
            shielded: false,
            transparent_only: true,
            unknown: false,
        },
        // A Unified address whose receiver pools were not recovered must not be
        // defaulted to shielded; report it as unknown.
        (AddressKind::Unified, None) => ReceiverPools {
            transparent: false,
            sapling: false,
            orchard: false,
            shielded: false,
            transparent_only: false,
            unknown: true,
        },
    };
    Ok(AddressInfo {
        address: parsed.encode(),
        kind: classified.kind,
        network: classified.network,
        can_receive_memo: parsed.can_receive_memo(),
        receivers,
    })
}

fn map_conversion_error<E: fmt::Debug>(e: ConversionError<E>) -> Error {
    match e {
        ConversionError::Unsupported(u) => {
            if format!("{u}").to_lowercase().contains("sprout") {
                Error::SproutUnsupported
            } else {
                Error::AddressParse(format!("unsupported address type: {u}"))
            }
        }
        ConversionError::User(e) => Error::AddressParse(format!("{e:?}")),
        ConversionError::IncorrectNetwork { expected, actual } => Error::NetworkMismatch {
            expected: format!("{expected:?}"),
            actual: format!("{actual:?}"),
        },
    }
}

/// Validate an address for a specific network. Rejects Sprout addresses.
pub fn validate_address(address: &str, network: BlinkNetwork) -> Result<AddressInfo> {
    let info = inspect_address(address)?;
    if info.network != network {
        return Err(Error::NetworkMismatch {
            expected: network.as_str().to_string(),
            actual: info.network.as_str().to_string(),
        });
    }
    Ok(info)
}

/* -------------------------------------------------------------------------- */
/* Amounts                                                                    */
/* -------------------------------------------------------------------------- */

/// Parse a decimal ZEC string into integer zatoshis, following the ZIP 321
/// amount grammar. Rejects malformed values rather than coercing them.
pub fn parse_zec_to_zatoshis(value: &str) -> Result<u64> {
    let v = value.trim();
    if v.is_empty() {
        return Err(Error::InvalidAmount("amount is empty".into()));
    }
    let mut parts = v.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some() {
        return Err(Error::InvalidAmount(format!("malformed amount: {value}")));
    }
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::InvalidAmount(format!("malformed amount: {value}")));
    }
    let frac = match fraction {
        None => String::new(),
        Some(f) => {
            if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Error::InvalidAmount(format!("malformed amount: {value}")));
            }
            if f.len() > 8 {
                return Err(Error::InvalidAmount(
                    "ZEC amounts support at most 8 decimal places".into(),
                ));
            }
            f.to_string()
        }
    };
    let whole_u: u64 = whole
        .parse()
        .map_err(|_| Error::InvalidAmount(format!("malformed amount: {value}")))?;
    let frac_padded = format!("{frac:0<8}");
    let frac_u: u64 = if frac_padded.is_empty() {
        0
    } else {
        frac_padded
            .parse()
            .map_err(|_| Error::InvalidAmount(format!("malformed amount: {value}")))?
    };
    let total = whole_u
        .checked_mul(ZATOSHIS_PER_ZEC)
        .and_then(|w| w.checked_add(frac_u))
        .ok_or_else(|| Error::InvalidAmount("amount overflows".into()))?;
    if total == 0 {
        return Err(Error::InvalidAmount(
            "amount must be greater than zero".into(),
        ));
    }
    if total > MAX_ZEC * ZATOSHIS_PER_ZEC {
        return Err(Error::InvalidAmount(
            "amount exceeds maximum ZEC supply".into(),
        ));
    }
    Ok(total)
}

/// Render integer zatoshis as a canonical decimal ZEC string.
pub fn format_zatoshis(zats: u64) -> String {
    let whole = zats / ZATOSHIS_PER_ZEC;
    let frac = zats % ZATOSHIS_PER_ZEC;
    if frac == 0 {
        whole.to_string()
    } else {
        let f = format!("{frac:08}");
        let trimmed = f.trim_end_matches('0');
        format!("{whole}.{trimmed}")
    }
}

/* -------------------------------------------------------------------------- */
/* ZIP 321 build / parse                                                      */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentSpec {
    pub address: String,
    /// Decimal ZEC amount, e.g. "25" or "0.5".
    pub amount: String,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedPayment {
    pub address: String,
    pub amount: String,
    pub memo: Option<String>,
    pub label: Option<String>,
    pub message: Option<String>,
}

/// Build a valid ZIP 321 URI. Every address and amount is validated first.
pub fn build_uri(payments: &[PaymentSpec], network: BlinkNetwork) -> Result<String> {
    if payments.is_empty() {
        return Err(Error::Payment("at least one payment is required".into()));
    }
    let mut built = Vec::with_capacity(payments.len());
    for spec in payments {
        let addr = ZcashAddress::try_from_encoded(&spec.address)
            .map_err(|e| Error::AddressParse(e.to_string()))?;
        let info = addr
            .clone()
            .convert::<Classified>()
            .map_err(map_conversion_error)?;
        if info.network != network {
            return Err(Error::NetworkMismatch {
                expected: network.as_str().to_string(),
                actual: info.network.as_str().to_string(),
            });
        }
        let zats = parse_zec_to_zatoshis(&spec.amount)?;
        let memo = match &spec.memo {
            Some(m) if !m.is_empty() => {
                if !addr.can_receive_memo() {
                    return Err(Error::InvalidMemo(
                        "memo is not supported for transparent recipients".into(),
                    ));
                }
                Some(
                    MemoBytes::from_bytes(m.as_bytes())
                        .map_err(|e| Error::InvalidMemo(e.to_string()))?,
                )
            }
            _ => None,
        };
        let payment = Payment::new(
            addr,
            Some(Zatoshis::from_u64(zats).map_err(|e| Error::InvalidAmount(e.to_string()))?),
            memo,
            spec.label.clone(),
            spec.message.clone(),
            vec![],
        )
        .map_err(|e| Error::Payment(e.to_string()))?;
        built.push(payment);
    }
    let request = TransactionRequest::new(built).map_err(|e| Error::Zip321(e.to_string()))?;
    Ok(request.to_uri())
}

/// Parse a ZIP 321 URI. When `network` is supplied, every address is required to
/// match it. Any malformed or unsupported required parameter is rejected.
pub fn parse_uri(uri: &str, network: Option<BlinkNetwork>) -> Result<Vec<ParsedPayment>> {
    let request = TransactionRequest::from_uri(uri).map_err(|e| Error::Zip321(e.to_string()))?;
    let mut out = Vec::new();
    for payment in request.payments().values() {
        let addr = payment.recipient_address().clone();
        let classified = addr
            .clone()
            .convert::<Classified>()
            .map_err(map_conversion_error)?;
        if let Some(expected) = network {
            if classified.network != expected {
                return Err(Error::NetworkMismatch {
                    expected: expected.as_str().to_string(),
                    actual: classified.network.as_str().to_string(),
                });
            }
        }
        let amount = match payment.amount() {
            Some(z) => format_zatoshis(z.into_u64()),
            None => "0".to_string(),
        };
        let memo = payment.memo().map(|m| {
            String::from_utf8_lossy(m.as_slice())
                .trim_end_matches('\0')
                .to_string()
        });
        out.push(ParsedPayment {
            address: addr.encode(),
            amount,
            memo,
            label: payment.label().cloned(),
            message: payment.message().cloned(),
        });
    }
    Ok(out)
}

/* -------------------------------------------------------------------------- */
/* Transaction decoding                                                       */
/* -------------------------------------------------------------------------- */

/// Consensus branch to assume when deserialising a transaction. A transaction
/// serialisation is self-describing for header fields, but pre-v5 versions use
/// the supplied branch to decide whether Overwinter/Sapling fields are present.
/// Block 419200 is the Sapling activation height on both mainnet and testnet, so
/// every V4-and-earlier transaction we may encounter (including the librustzcash
/// reference vector from testnet block 280003) decodes correctly, while V5/V6
/// (NU5 and later) carry their flags explicitly and ignore this value.
fn default_branch_for_decode() -> BranchId {
    BranchId::Sapling
}

fn parse_branch(name: &str) -> Option<BranchId> {
    Some(match name.to_ascii_lowercase().as_str() {
        "sprout" => BranchId::Sprout,
        "overwinter" => BranchId::Overwinter,
        "sapling" => BranchId::Sapling,
        "blossom" => BranchId::Blossom,
        "heartwood" => BranchId::Heartwood,
        "canopy" => BranchId::Canopy,
        "nu5" => BranchId::Nu5,
        "nu6" => BranchId::Nu6,
        "nu6.1" | "nu6_1" => BranchId::Nu6_1,
        "nu6.2" | "nu6_2" => BranchId::Nu6_2,
        "nu6.3" | "nu6_3" => BranchId::Nu6_3,
        _ => return None,
    })
}

/// The authoritative details of a decoded Zcash transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionInfo {
    /// The canonical transaction id (big-endian hex), computed from the bytes.
    pub txid: String,
    pub size: usize,
}

/// The pools a transaction touches, derived from its bundles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxPools {
    pub transparent: bool,
    pub sapling: bool,
    pub orchard: bool,
    /// Whether the transaction carries a shielded (Sapling or Orchard) bundle.
    pub shielded: bool,
}

/// A transparent output of a transaction: the recipient address and its value.
/// Both are public on-chain data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransparentOutput {
    /// The recipient transparent address, encoded for the requested network.
    pub address: String,
    /// The output value, in zatoshis.
    pub value_zatoshis: u64,
}

/// What can honestly be established from a transaction's public bytes.
///
/// This is the verification boundary. A transparent recipient and amount are
/// public, so they can be matched. A shielded recipient and amount are not
/// public: a third party without the recipient's viewing key cannot prove them,
/// and this structure never pretends otherwise — `shielded` reports only that a
/// shielded bundle is present, not who or how much it paid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionEvidence {
    pub txid: String,
    pub size: usize,
    pub pools: TxPools,
    /// Every transparent output (recipient + value), in order.
    pub transparent_outputs: Vec<TransparentOutput>,
    /// Whether the expected recipient address exposes a transparent receiver.
    pub recipient_has_transparent: bool,
    /// Whether the expected recipient address exposes a shielded receiver.
    pub recipient_has_shielded: bool,
    /// The total zatoshis the transaction pays to the expected recipient's
    /// transparent receiver, when it has one and the transaction pays it.
    pub transparent_recipient_zatoshis: Option<u64>,
}

/// Decode raw Zcash transaction bytes and return the real txid.
///
/// The txid is derived from the transaction itself using the official
/// `zcash_primitives` implementation, so a caller cannot substitute an arbitrary
/// hash. This is what lets BLINK bind a lightwalletd `GetTransaction` response
/// to a verifiable transaction id rather than trusting a client-supplied value.
///
/// The mined height is deliberately not returned: transaction bytes do not carry
/// it. It is supplied by lightwalletd's `RawTransaction.height`, which the caller
/// must translate into confirmations against the current chain tip.
pub fn decode_transaction(data: &[u8], branch: Option<&str>) -> Result<TransactionInfo> {
    let tx = read_transaction(data, branch)?;
    Ok(TransactionInfo {
        txid: tx.txid().to_string(),
        size: data.len(),
    })
}

fn read_transaction(data: &[u8], branch: Option<&str>) -> Result<Transaction> {
    let branch = match branch {
        Some(name) => parse_branch(name)
            .ok_or_else(|| Error::Transaction(format!("unknown branch: {name}")))?,
        None => default_branch_for_decode(),
    };
    Transaction::read(Cursor::new(data), branch)
        .map_err(|e| Error::Transaction(format!("could not decode: {e}")))
}

/// A classifier that recovers a Unified Address's receiver list.
struct UaOnly(unified::Address);

impl TryFromAddress for UaOnly {
    type Error = std::convert::Infallible;

    fn try_from_unified(
        _net: NetworkType,
        ua: unified::Address,
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(UaOnly(ua))
    }
}

/// The transparent receiver an address exposes, encoded for `network`.
///
/// For a transparent address this is the address itself. For a Unified Address it
/// is the P2PKH or P2SH receiver, when present — the receiver a wallet could
/// silently settle into. For a Sapling address there is none.
fn transparent_receiver_address(address: &str, network: BlinkNetwork) -> Result<Option<String>> {
    let parsed =
        ZcashAddress::try_from_encoded(address).map_err(|e| Error::AddressParse(e.to_string()))?;
    let net = network.to_network_type();
    if let Ok(UaOnly(ua)) = parsed.clone().convert::<UaOnly>() {
        for item in ua.items() {
            match item {
                unified::Receiver::P2pkh(d) => {
                    return Ok(Some(
                        TransparentAddress::PublicKeyHash(d)
                            .to_zcash_address(net)
                            .encode(),
                    ));
                }
                unified::Receiver::P2sh(d) => {
                    return Ok(Some(
                        TransparentAddress::ScriptHash(d)
                            .to_zcash_address(net)
                            .encode(),
                    ));
                }
                _ => {}
            }
        }
        return Ok(None);
    }
    if let Ok(t) = parsed.convert::<TransparentAddress>() {
        return Ok(Some(t.to_zcash_address(net).encode()));
    }
    Ok(None)
}

/// Whether an address exposes a shielded (Sapling or Orchard) receiver.
///
/// Reuses the same classifier as [`inspect_address`], so the answer is exactly
/// the composition BLINK accepts or rejects elsewhere. An address that cannot be
/// parsed returns false — never inferred.
fn has_shielded_receiver(address: &str) -> bool {
    inspect_address(address)
        .map(|info| info.receivers.shielded)
        .unwrap_or(false)
}

/// Decode a transaction and report the public facts relevant to verification:
/// which pools it touches, every transparent output, and how much it pays to the
/// expected recipient's transparent receiver (if that recipient has one).
///
/// This is deliberately the *maximum* a third party can establish from public
/// bytes. It never reports a shielded recipient or amount, because those are not
/// public. A shielded request therefore yields `transparent_recipient_zatoshis:
/// None` and `pools.shielded: true` — enough to reject a transparent settlement
/// and to confirm a shielded bundle is present, but never enough to claim who was
/// paid or how much.
pub fn inspect_transaction(
    data: &[u8],
    branch: Option<&str>,
    network: BlinkNetwork,
    expected_address: Option<&str>,
) -> Result<TransactionEvidence> {
    let tx = read_transaction(data, branch)?;
    let net = network.to_network_type();

    let transparent_bundle = tx.transparent_bundle();
    let sapling = tx.sapling_bundle().is_some();
    let orchard = tx.orchard_bundle().is_some();

    let mut transparent_outputs = Vec::new();
    if let Some(bundle) = transparent_bundle {
        for out in &bundle.vout {
            if let Some(addr) = out.recipient_address() {
                transparent_outputs.push(TransparentOutput {
                    address: addr.to_zcash_address(net).encode(),
                    value_zatoshis: out.value().into_u64(),
                });
            }
        }
    }

    let expected = match expected_address {
        Some(address) => transparent_receiver_address(address, network)?,
        None => None,
    };
    let mut matched: u64 = 0;
    let mut matched_any = false;
    if let Some(expected_addr) = &expected {
        for out in &transparent_outputs {
            if &out.address == expected_addr {
                matched = matched.saturating_add(out.value_zatoshis);
                matched_any = true;
            }
        }
    }

    Ok(TransactionEvidence {
        txid: tx.txid().to_string(),
        size: data.len(),
        pools: TxPools {
            transparent: transparent_bundle.is_some(),
            sapling,
            orchard,
            shielded: sapling || orchard,
        },
        transparent_outputs,
        recipient_has_transparent: expected.is_some(),
        recipient_has_shielded: expected_address.map(has_shielded_receiver).unwrap_or(false),
        transparent_recipient_zatoshis: if matched_any { Some(matched) } else { None },
    })
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    // Known-good testnet Sapling address from ZIP 321.
    const TEST_SAPLING: &str =
        "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez";
    // Mainnet transparent P2PKH address.
    const MAIN_TADDR: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

    #[test]
    fn classifies_testnet_sapling() {
        let info = inspect_address(TEST_SAPLING).unwrap();
        assert_eq!(info.kind, AddressKind::Sapling);
        assert_eq!(info.network, BlinkNetwork::Testnet);
        assert!(info.can_receive_memo);
    }

    #[test]
    fn classifies_mainnet_transparent() {
        let info = inspect_address(MAIN_TADDR).unwrap();
        assert_eq!(info.kind, AddressKind::Transparent);
        assert_eq!(info.network, BlinkNetwork::Mainnet);
        assert!(!info.can_receive_memo);
    }

    #[test]
    fn rejects_network_mismatch() {
        let err = validate_address(TEST_SAPLING, BlinkNetwork::Mainnet).unwrap_err();
        assert!(matches!(err, Error::NetworkMismatch { .. }));
    }

    #[test]
    fn rejects_garbage_address() {
        assert!(inspect_address("not-an-address").is_err());
    }

    #[test]
    fn amount_round_trip() {
        assert_eq!(parse_zec_to_zatoshis("25").unwrap(), 2_500_000_000);
        assert_eq!(parse_zec_to_zatoshis("0.5").unwrap(), 50_000_000);
        assert_eq!(format_zatoshis(2_500_000_000), "25");
        assert_eq!(format_zatoshis(50_000_000), "0.5");
    }

    #[test]
    fn rejects_bad_amounts() {
        assert!(parse_zec_to_zatoshis(".5").is_err());
        assert!(parse_zec_to_zatoshis("50.").is_err());
        assert!(parse_zec_to_zatoshis("50,000").is_err());
        assert!(parse_zec_to_zatoshis("0.123456789").is_err());
        assert!(parse_zec_to_zatoshis("0").is_err());
    }

    #[test]
    fn build_and_parse_round_trip() {
        let spec = PaymentSpec {
            address: TEST_SAPLING.to_string(),
            amount: "1.5".to_string(),
            memo: Some("Dinner".to_string()),
            label: Some("Joseph".to_string()),
            message: Some("Thanks!".to_string()),
        };
        let uri = build_uri(&[spec], BlinkNetwork::Testnet).unwrap();
        assert!(uri.starts_with("zcash:ztestsapling1"));

        let parsed = parse_uri(&uri, Some(BlinkNetwork::Testnet)).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].amount, "1.5");
        assert_eq!(parsed[0].memo.as_deref(), Some("Dinner"));
        assert_eq!(parsed[0].label.as_deref(), Some("Joseph"));
    }

    #[test]
    fn build_rejects_wrong_network() {
        let spec = PaymentSpec {
            address: TEST_SAPLING.to_string(),
            amount: "1".to_string(),
            memo: None,
            label: None,
            message: None,
        };
        assert!(build_uri(&[spec], BlinkNetwork::Mainnet).is_err());
    }

    #[test]
    fn parse_rejects_mainnet_address_on_testnet() {
        let spec = PaymentSpec {
            address: MAIN_TADDR.to_string(),
            amount: "1".to_string(),
            memo: None,
            label: None,
            message: None,
        };
        let uri = build_uri(&[spec], BlinkNetwork::Mainnet).unwrap();
        assert!(parse_uri(&uri, Some(BlinkNetwork::Testnet)).is_err());
    }

    #[test]
    fn memo_to_transparent_is_rejected() {
        let spec = PaymentSpec {
            address: MAIN_TADDR.to_string(),
            amount: "1".to_string(),
            memo: Some("nope".to_string()),
            label: None,
            message: None,
        };
        assert!(build_uri(&[spec], BlinkNetwork::Mainnet).is_err());
    }

    /// A transparent-only address must never advertise a shielded receiver, and a
    /// shielded address must, so the verification boundary reports them honestly.
    #[test]
    fn shielded_receiver_detection_matches_address_kind() {
        assert!(has_shielded_receiver(TEST_SAPLING));
        assert!(!has_shielded_receiver(MAIN_TADDR));
        assert!(!has_shielded_receiver("not-an-address"));
    }

    /// A mixed Unified Address (a shielded receiver plus a transparent one) must
    /// report both pools, and its composition must fail the shielded-only policy.
    #[test]
    fn classifies_a_mixed_unified_address_as_not_shielded_only() {
        // R2 testnet UA: transparent + Orchard.
        let ua = "tutest1g8sgu2gqav6mcswxfnha3yg7ajeznk6ykj3as93tnh32yyq56t9d32dxzgw66r5s4dge2gpr4m54ac9djwr4lm550u8ctpw9h6fl9f632j2dvq7cwugf5pyu5eds7gm5rtuxgrez927";
        let info = inspect_address(ua).unwrap();
        assert_eq!(info.kind, AddressKind::Unified);
        assert!(info.receivers.transparent);
        assert!(info.receivers.orchard);
        assert!(info.receivers.shielded);
        assert!(!info.receivers.transparent_only);
    }

    #[test]
    fn transparent_receiver_address_extracts_the_ua_transparent_receiver() {
        // A mainnet Unified Address that exposes a transparent (P2PKH) receiver
        // alongside a Sapling one; the transparent receiver must be recoverable.
        let ua = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf";
        let extracted = transparent_receiver_address(ua, BlinkNetwork::Mainnet).unwrap();
        assert!(extracted.is_some());
        // A Sapling address exposes no transparent receiver to pay.
        assert!(
            transparent_receiver_address(TEST_SAPLING, BlinkNetwork::Testnet)
                .unwrap()
                .is_none()
        );
    }

    /// The transaction-inspection evidence is grounded in a real decoded testnet
    /// transaction, never fabricated. The fixture is the official
    /// `zcash_primitives` round-trip vector.
    #[test]
    fn inspect_transaction_reports_pools_and_recipient_from_real_bytes() {
        let hex = include_str!("../tests/data/tx_read_write.hex").trim();
        let bytes: Vec<u8> = hex
            .as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();

        let evidence =
            inspect_transaction(&bytes, None, BlinkNetwork::Testnet, Some(TEST_SAPLING)).unwrap();
        assert_eq!(evidence.size, 2005);
        // The shielded flag is derived from the bundles, never asserted blindly.
        assert_eq!(
            evidence.pools.shielded,
            evidence.pools.sapling || evidence.pools.orchard
        );
        // A shielded recipient does not expose a transparent receiver, so no
        // amount can be attributed to it from public bytes.
        assert!(evidence.recipient_has_shielded);
        assert!(!evidence.recipient_has_transparent);
        assert_eq!(evidence.transparent_recipient_zatoshis, None);
    }
}
