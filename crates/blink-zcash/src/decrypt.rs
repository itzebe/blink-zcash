//! Recipient-side shielded note discovery.
//!
//! Observing that a transaction carries a shielded bundle proves only that
//! *someone* moved value into a shielded pool. It does not prove that the
//! intended recipient received anything. The only way to establish that from
//! public chain data is to trial-decrypt the transaction's shielded outputs with
//! the recipient's *incoming viewing key* (IVK) and check the recovered notes.
//!
//! This module does exactly that, and nothing more:
//!
//!  * It accepts a Unified Incoming Viewing Key (`uivk…` / `uivktest…`) or a
//!    Unified Full Viewing Key (`uview…` / `uviewtest…`) — the standard ZIP 316
//!    encodings a wallet can export. Both can *detect* incoming notes; neither
//!    can spend. A viewing key is a strictly weaker capability than a spending
//!    key, and BLINK only ever handles the viewing form.
//!  * It never accepts, derives or stores a spending key. A raw per-pool IVK has
//!    no standard serialization in the ecosystem, so it is not accepted; the
//!    Unified form is the interoperable one.
//!  * It returns only the minimum needed to decide whether the payment landed:
//!    the value of each recovered note and whether its recipient address equals
//!    the expected recipient. Memos are deliberately **not** returned.
//!
//! ## Which pool an address can receive into
//!
//! A Sapling payment address receives only into Sapling. A Unified Address may
//! carry a Sapling receiver, an Orchard receiver, or both; a wallet paying it
//! picks one. The Orchard and Sapling trial decryptions below are therefore run
//! independently, and the per-pool results are reported separately — a caller
//! can never mistake "an Orchard note matched" for "a Sapling note matched".

use serde::{Deserialize, Serialize};
use zcash_address::unified::Container;
use zcash_address::{unified, ConversionError, TryFromAddress, ZcashAddress};
use zcash_note_encryption::try_compact_note_decryption;
use zcash_protocol::consensus::NetworkType;

use crate::{BlinkNetwork, Error, Result};

/// Sapling ZIP 212 enforcement. ZIP 212 has been enforced on both networks BLINK
/// supports since Canopy, so a valid note plaintext must carry the post-ZIP-212
/// lead byte. `On` is the strict policy and rejects a pre-ZIP-212 lead byte
/// rather than accepting a legacy encoding.
const ZIP212_ENFORCEMENT: sapling_crypto::note_encryption::Zip212Enforcement =
    sapling_crypto::note_encryption::Zip212Enforcement::On;

/// A viewing key BLINK can use to detect incoming notes.
///
/// A Unified viewing key may carry a Sapling component, an Orchard component, or
/// both. At least one shielded component must be present: a key that can decrypt
/// nothing cannot verify anything, and is rejected rather than silently accepted.
pub struct RecipientViewingKey {
    sapling: Option<sapling_crypto::zip32::IncomingViewingKey>,
    orchard: Option<orchard::keys::IncomingViewingKey>,
}

impl std::fmt::Debug for RecipientViewingKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never render key bytes.
        f.debug_struct("RecipientViewingKey")
            .field("sapling", &self.sapling.is_some())
            .field("orchard", &self.orchard.is_some())
            .finish()
    }
}

impl RecipientViewingKey {
    pub fn has_sapling(&self) -> bool {
        self.sapling.is_some()
    }

    pub fn has_orchard(&self) -> bool {
        self.orchard.is_some()
    }

    /// Parse a Unified viewing key (`uivk…`/`uview…`, or their `…test` forms) and
    /// check it belongs to the requested network. The ZIP 316 encoding carries the
    /// network, so a key minted for another network is rejected outright — a
    /// testnet key can never be used to verify a mainnet payment.
    ///
    /// Both the Unified Incoming Viewing Key (`uivk…`) and the Unified Full
    /// Viewing Key (`uview…`) are accepted: wallets commonly export the full key,
    /// and its incoming-viewing form is derived here. Either form can only detect
    /// incoming notes. The two encodings carry distinct ZIP 316 prefixes, so a
    /// string can only ever parse as one of them — the fallback is unambiguous.
    pub fn parse(encoded: &str, network: BlinkNetwork) -> Result<Self> {
        let trimmed = encoded.trim();
        if trimmed.is_empty() {
            return Err(Error::ViewingKey("viewing key is empty".to_string()));
        }
        let params = network_params(network);
        let uivk = match zcash_keys::keys::UnifiedIncomingViewingKey::decode(&params, trimmed) {
            Ok(uivk) => uivk,
            Err(uivk_err) => {
                let ufvk = zcash_keys::keys::UnifiedFullViewingKey::decode(&params, trimmed)
                    .map_err(|ufvk_err| {
                        Error::ViewingKey(format!(
                            "not a Unified viewing key (UIVK: {uivk_err}; UFVK: {ufvk_err})"
                        ))
                    })?;
                ufvk.to_unified_incoming_viewing_key()
            }
        };
        if !uivk.has_sapling() && !uivk.has_orchard() {
            return Err(Error::ViewingKey(
                "viewing key carries no shielded (Sapling or Orchard) component".to_string(),
            ));
        }
        Ok(RecipientViewingKey {
            sapling: uivk.sapling().clone(),
            orchard: uivk.orchard().clone(),
        })
    }

    /// Which pools this key can decrypt for.
    pub fn capability(&self) -> ViewingKeyCapability {
        ViewingKeyCapability {
            sapling: self.has_sapling(),
            orchard: self.has_orchard(),
        }
    }

    /// Whether this key can derive a shielded receiver of `address`.
    ///
    /// A Unified viewing key is scoped to a whole *account*, so a key that
    /// belongs to the account behind `address` can re-derive at least one of the
    /// address's shielded receivers; a key for any other account derives none of
    /// them. This is what binds a supplied key to the request's recipient, so a
    /// requester cannot attach a key that could never verify the payment.
    ///
    /// It only ever returns `true` on a byte-for-byte receiver match, and never
    /// treats "the key is well-formed" as "the key belongs here".
    pub fn matches_address(&self, address: &str) -> Result<bool> {
        let parsed = ZcashAddress::try_from_encoded(address)
            .map_err(|e| Error::AddressParse(e.to_string()))?;
        let expected = parsed
            .convert::<ShieldedRecipient>()
            .map_err(|_| Error::Payment("recipient has no shielded receiver".to_string()))?;

        if let (Some(ivk), Some(bytes)) = (self.sapling.as_ref(), expected.sapling) {
            if let Some(addr) = sapling_crypto::PaymentAddress::from_bytes(&bytes) {
                // Re-derive the address from the key's diversifier and compare.
                if ivk.address(*addr.diversifier()).as_ref() == Some(&addr) {
                    return Ok(true);
                }
            }
        }
        if let (Some(ivk), Some(bytes)) = (self.orchard.as_ref(), expected.orchard) {
            if let Some(addr) = orchard::Address::from_raw_address_bytes(&bytes).into_option() {
                if ivk.diversifier_index(&addr).is_some() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

/// A non-secret summary of a supplied Unified viewing key, returned by the engine
/// so the API can validate a key *before* associating it with a request. It never
/// contains key material.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewingKeyInspection {
    /// Always `true` when the call succeeds: an unparseable key is an error, not
    /// an inspection with `valid: false`.
    pub valid: bool,
    /// The network the key is scoped to (`mainnet`/`testnet`).
    pub network: String,
    /// Whether the key can decrypt Sapling notes.
    pub sapling: bool,
    /// Whether the key can decrypt Orchard notes.
    pub orchard: bool,
    /// Whether the key can derive a shielded receiver of the supplied address.
    /// `None` when no address was supplied.
    pub address_matches_key: Option<bool>,
}

/// Parse a Unified viewing key and report its capability, and — when an address
/// is supplied — whether the key can derive that address's shielded receiver.
///
/// An unparseable key, a wrong-network key, or a key with no shielded component
/// is an `Err` (the caller must not associate it with a request).
pub fn inspect_viewing_key(
    encoded: &str,
    network: BlinkNetwork,
    expected_address: Option<&str>,
) -> Result<ViewingKeyInspection> {
    let key = RecipientViewingKey::parse(encoded, network)?;
    let address_matches_key = match expected_address {
        Some(address) => Some(key.matches_address(address)?),
        None => None,
    };
    Ok(ViewingKeyInspection {
        valid: true,
        network: network.as_str().to_string(),
        sapling: key.has_sapling(),
        orchard: key.has_orchard(),
        address_matches_key,
    })
}

/// Which pools a viewing key can decrypt for. Reported to the operator before
/// any transaction exists, so the capability of the opt-in key is explicit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewingKeyCapability {
    pub sapling: bool,
    pub orchard: bool,
}

fn network_params(network: BlinkNetwork) -> zcash_protocol::consensus::Network {
    match network {
        BlinkNetwork::Mainnet => zcash_protocol::consensus::Network::MainNetwork,
        BlinkNetwork::Testnet => zcash_protocol::consensus::Network::TestNetwork,
    }
}

/// What was recovered from a single shielded output, if anything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecryptedNote {
    /// The pool the note was found in: `sapling` or `orchard`.
    pub pool: String,
    /// The recovered note value, in zatoshis.
    pub value_zatoshis: u64,
    /// Whether the note's recipient address equals the requested recipient.
    pub recipient_match: bool,
}

/// The result of trial-decrypting a transaction's shielded outputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDecryption {
    /// The transaction id, computed from the bytes (never trusted from input).
    pub txid: String,
    /// Whether the computed txid equals the expected txid, when one was supplied.
    /// This is what binds the decoded transaction to the payment request: a payer
    /// cannot point BLINK at an unrelated mined transaction.
    pub txid_matches: bool,
    /// Every note recovered with the supplied viewing key.
    pub notes: Vec<DecryptedNote>,
    /// Total zatoshis across notes whose recipient matched the requested one.
    pub matched_zatoshis: u64,
    /// Whether the viewing key had a Sapling component.
    pub key_has_sapling: bool,
    /// Whether the viewing key had an Orchard component.
    pub key_has_orchard: bool,
}

/// The shielded recipient payloads (raw 43-byte encodings) an address exposes.
struct ShieldedRecipient {
    sapling: Option<[u8; 43]>,
    orchard: Option<[u8; 43]>,
}

impl TryFromAddress for ShieldedRecipient {
    type Error = std::convert::Infallible;

    fn try_from_sapling(
        _net: NetworkType,
        data: [u8; 43],
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        Ok(ShieldedRecipient {
            sapling: Some(data),
            orchard: None,
        })
    }

    fn try_from_unified(
        _net: NetworkType,
        ua: unified::Address,
    ) -> std::result::Result<Self, ConversionError<Self::Error>> {
        let mut sapling = None;
        let mut orchard = None;
        for item in ua.items() {
            match item {
                unified::Receiver::Sapling(d) => sapling = Some(d),
                unified::Receiver::Orchard(d) => orchard = Some(d),
                _ => {}
            }
        }
        Ok(ShieldedRecipient { sapling, orchard })
    }
}

/// Trial-decrypt every shielded output of `data` with `key`, and report which
/// recovered notes belong to `expected_address`.
///
/// A note is only ever attributed to the expected recipient when its recovered
/// recipient address is byte-for-byte the requested one. A note that decrypts
/// with the key but pays a *different* diversified address derived from the same
/// key is reported as `recipient_match: false`, so a caller can never treat "a
/// note decrypts" as "the requested recipient was paid".
///
/// `expected_txid`, when supplied (lowercase hex), is compared against the txid
/// computed from the bytes. A mismatch is reported as `txid_matches: false` and
/// never yields a recipient match — the decoded transaction is not the one the
/// request is about.
pub fn decrypt_notes(
    data: &[u8],
    branch: Option<&str>,
    key: &RecipientViewingKey,
    expected_address: &str,
    expected_txid: Option<&str>,
) -> Result<NoteDecryption> {
    let tx = crate::read_transaction(data, branch)?;
    let parsed = ZcashAddress::try_from_encoded(expected_address)
        .map_err(|e| Error::AddressParse(e.to_string()))?;
    let expected = parsed
        .convert::<ShieldedRecipient>()
        .map_err(|_| Error::Payment("recipient has no shielded receiver".to_string()))?;

    let txid = tx.txid().to_string();
    let txid_matches = match expected_txid {
        Some(want) => want.trim().eq_ignore_ascii_case(&txid),
        None => true,
    };

    let mut notes: Vec<DecryptedNote> = Vec::new();

    // Sapling: one trial decryption per output.
    if let (Some(ivk), Some(bundle)) = (key.sapling.as_ref(), tx.sapling_bundle()) {
        let prepared = ivk.prepare();
        for output in bundle.shielded_outputs() {
            if let Some((note, payment_address)) =
                sapling_crypto::note_encryption::try_sapling_compact_note_decryption(
                    &prepared,
                    output,
                    ZIP212_ENFORCEMENT,
                )
            {
                let recipient_match = expected
                    .sapling
                    .map(|expected| expected == payment_address.to_bytes())
                    .unwrap_or(false);
                notes.push(DecryptedNote {
                    pool: "sapling".to_string(),
                    value_zatoshis: note.value().inner(),
                    recipient_match,
                });
            }
        }
    }

    // Orchard: one trial decryption per action, with the domain bound to that
    // action's rho.
    if let (Some(ivk), Some(bundle)) = (key.orchard.as_ref(), tx.orchard_bundle()) {
        let prepared = ivk.prepare();
        for action in bundle.actions().iter() {
            let domain = orchard::note_encryption::OrchardDomain::for_action(action);
            if let Some((note, address)) = try_compact_note_decryption(&domain, &prepared, action) {
                let recipient_match = expected
                    .orchard
                    .map(|expected| expected == address.to_raw_address_bytes())
                    .unwrap_or(false);
                notes.push(DecryptedNote {
                    pool: "orchard".to_string(),
                    value_zatoshis: note.value().inner(),
                    recipient_match,
                });
            }
        }
    }

    let matched_zatoshis = notes
        .iter()
        .filter(|n| n.recipient_match)
        .fold(0u64, |acc, n| acc.saturating_add(n.value_zatoshis));

    Ok(NoteDecryption {
        txid,
        txid_matches,
        notes,
        matched_zatoshis,
        key_has_sapling: key.has_sapling(),
        key_has_orchard: key.has_orchard(),
    })
}
