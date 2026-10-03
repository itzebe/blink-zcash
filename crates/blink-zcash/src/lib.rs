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

use serde::{Deserialize, Serialize};
use zcash_address::{ConversionError, TryFromAddress, ZcashAddress};
use zcash_protocol::{consensus::NetworkType, memo::MemoBytes, value::Zatoshis};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddressInfo {
    pub address: String,
    pub kind: AddressKind,
    pub network: BlinkNetwork,
    pub can_receive_memo: bool,
}

/// A classifier used with [`ZcashAddress::convert`]. The default trait methods
/// reject Sprout addresses, which is exactly the ZIP 321 requirement. The tuple
/// conversion lets us recover both the network and the address kind from a
/// single parse.
#[derive(Debug, Clone, Copy)]
pub struct Classified {
    pub network: BlinkNetwork,
    pub kind: AddressKind,
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
        })
    }

    fn try_from_unified(
        net: NetworkType,
        _data: zcash_address::unified::Address,
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Unified,
        })
    }

    fn try_from_transparent_p2pkh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Transparent,
        })
    }

    fn try_from_transparent_p2sh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(Classified {
            network: network_type_to_blink(net),
            kind: AddressKind::Transparent,
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
    Ok(AddressInfo {
        address: parsed.encode(),
        kind: classified.kind,
        network: classified.network,
        can_receive_memo: parsed.can_receive_memo(),
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
}
