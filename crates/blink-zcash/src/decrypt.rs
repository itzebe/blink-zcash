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
    pub fn parse(encoded: &str, network: BlinkNetwork) -> Result<Self> {
        let trimmed = encoded.trim();
        if trimmed.is_empty() {
            return Err(Error::ViewingKey("viewing key is empty".to_string()));
        }
        let params = network_params(network);
        let uivk = zcash_keys::keys::UnifiedIncomingViewingKey::decode(&params, trimmed)
            .map_err(Error::ViewingKey)?;
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
