//! Authoritative shielded-recipient verification tests.
//!
//! These exercise the *production* verification path — `verify_shielded_payment`
//! and the trial-decryption in `src/decrypt.rs` — against synthetic transactions
//! built in-process with the official Zcash crates. There is no mock that returns
//! `recipient_verified: true`: every assertion runs the real trial decryption over
//! real note ciphertexts, so a regression in the recipient/value accounting fails
//! the test.
//!
//! The fixtures respect the protocol rather than bypassing it. In particular, an
//! Orchard note's `rho` is bound to the action's nullifier (the Orchard domain
//! derives `rho` from `nf` during trial decryption), so the fixture derives `rho`
//! from the same nullifier it places in the action — see `build_orchard_tx`.
//!
//! The transactions are synthetic: they are not mined, not broadcast, and are
//! never evidence of a real payment. They exist only to prove that BLINK's
//! decryption and accounting are correct.

use std::convert::TryFrom;

use sapling_crypto as sapling;

// --- Orchard fixtures -------------------------------------------------------

use nonempty::NonEmpty;
use orchard::bundle::{Authorized, Bundle, BundleVersion, EffectsOnly, Flags};
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{ExtractedNoteCommitment, NoteVersion, Nullifier, RandomSeed, Rho};
use orchard::note_encryption::{OrchardDomain, OrchardNoteEncryption};
use orchard::primitives::redpallas::{Binding, Signature, SpendAuth, VerificationKey};
use orchard::tree::Anchor as OrchardAnchor;
use orchard::value::{NoteValue, ValueCommitment};
use orchard::{Action, Address, Note, Proof};
use subtle::CtOption;
use zcash_note_encryption::Domain;

// --- Sapling fixtures -------------------------------------------------------

use sapling::builder::{Builder, BundleType};
use sapling::note_encryption::Zip212Enforcement;
use sapling::prover::mock::{MockOutputProver, MockSpendProver};
use sapling::value::NoteValue as SaplingNoteValue;
use sapling::zip32::ExtendedSpendingKey;
use sapling::Anchor as SaplingAnchor;

// --- Shared ----------------------------------------------------------------

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use zcash_address::ToAddress;
use zcash_keys::keys::UnifiedIncomingViewingKey;
use zcash_primitives::transaction::{TransactionData, TxVersion};
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkType, TEST_NETWORK};
use zcash_protocol::value::ZatBalance;

use blink_zcash::{BlinkNetwork, RecipientViewingKey};

const VALUE: u64 = 25_000_000; // 0.25 ZEC

fn opt<T>(c: CtOption<T>) -> Option<T> {
    c.into_option()
}

/// A synthetic Orchard transaction, its recipient, and its viewing key.
struct OrchardFixture {
    bytes: Vec<u8>,
    /// An Orchard-only Unified Address for the exact recipient the note pays.
    ua: String,
    /// The recipient's Unified Incoming Viewing Key.
    uivk: String,
    /// A second Orchard-only Unified Address, derived from the *same* key but a
    /// different diversifier (a different receiver under one account).
    other_diversifier_ua: String,
    /// A Unified Incoming Viewing Key for a *different* Orchard account.
    other_account_uivk: String,
    /// An Orchard-only Unified Address for that different account.
    other_account_ua: String,
}

fn orchard_account(seed: [u8; 32], index: u32) -> (String, String, Address) {
    let sk = SpendingKey::from_bytes(seed).expect("spending key");
    let fvk = FullViewingKey::from(&sk);
    let ivk = fvk.to_ivk(Scope::External);
    let address = fvk.address_at(index, Scope::External);
    let ua =
        zcash_keys::address::UnifiedAddress::from_receivers(Some(address), None, None, None, None)
            .expect("ua")
            .to_zcash_address(NetworkType::Test)
            .encode();
    let uivk = UnifiedIncomingViewingKey::new(None, Some(ivk), vec![], None, None, vec![])
        .encode(&TEST_NETWORK);
    (ua, uivk, address)
}

/// Build a well-formed v5 transaction carrying a single Orchard output of
/// `value` zatoshis to `recipient`.
fn build_orchard_tx(recipient: Address, value: u64, seed: u64) -> Vec<u8> {
    let mut rng = StdRng::seed_from_u64(seed);

    // The note's rho is bound to the action's nullifier: the Orchard domain
    // derives rho from nf during trial decryption, so the fixture must derive rho
    // from the same nullifier it puts in the action. `Rho::from_nf_old` is
    // crate-private; `Rho::from_bytes(nf.to_bytes())` is the public equivalent.
    let nf = loop {
        let mut b = [0u8; 32];
        rng.fill_bytes(&mut b);
        if let Some(n) = opt(Nullifier::from_bytes(&b)) {
            break n;
        }
    };
    let rho = opt(Rho::from_bytes(&nf.to_bytes())).expect("rho from nullifier");
    let rseed = loop {
        let mut b = [0u8; 32];
        rng.fill_bytes(&mut b);
        if let Some(r) = opt(RandomSeed::from_bytes(b, &rho)) {
            break r;
        }
    };

    let note = Note::from_parts(
        recipient,
        NoteValue::from_raw(value),
        rho,
        rseed,
        NoteVersion::V2,
    )
    .into_option()
    .expect("note");

    // cv_net is never consulted by trial decryption; a valid Pallas point is all
    // the Action needs to serialize.
    let cv_net = opt(ValueCommitment::from_bytes(&[0u8; 32])).expect("identity value commitment");
    let cmx = ExtractedNoteCommitment::from(note.commitment());

    let encryptor = OrchardNoteEncryption::new(None, note, [0u8; 512]);
    let epk_bytes = OrchardDomain::epk_bytes(encryptor.epk()).0;
    let enc_ciphertext = encryptor.encrypt_note_plaintext();
    let out_ciphertext = encryptor.encrypt_outgoing_plaintext(&cv_net, &cmx, &mut rng);
    let ciphertext = orchard::note::TransmittedNoteCiphertext {
        epk_bytes,
        enc_ciphertext,
        out_ciphertext,
    };

    let rk = {
        let sk = loop {
            let mut b = [0u8; 32];
            rng.fill_bytes(&mut b);
            if let Ok(k) = orchard::primitives::redpallas::SigningKey::<SpendAuth>::try_from(b) {
                break k;
            }
        };
        VerificationKey::<SpendAuth>::from(&sk)
    };

    let action = Action::from_parts(nf, rk, cmx, ciphertext, cv_net, ()).expect("action");

    let effects_only = Bundle::<EffectsOnly, ZatBalance>::from_parts(
        NonEmpty::new(action),
        Flags::SPENDS_DISABLED,
        ZatBalance::zero(),
        OrchardAnchor::empty_tree(),
        EffectsOnly,
        BundleVersion::orchard_v2(),
    )
    .expect("effects-only bundle");

    // Attach fake authorizing data of the canonical proof length so the bundle
    // serializes as a well-formed v5 Orchard bundle.
    let authorized: Bundle<Authorized, ZatBalance> = effects_only.map_authorization(
        &mut (),
        |_ctx, _auth, _| Signature::<SpendAuth>::from([0u8; 64]),
        |_ctx, _auth| {
            Authorized::from_parts(
                Proof::new(vec![0u8; Proof::expected_proof_size(1)]),
                Signature::<Binding>::from([0u8; 64]),
            )
        },
    );

    let tx = TransactionData::from_parts(
        TxVersion::V5,
        BranchId::Nu5,
        0,
        BlockHeight::from_u32(0),
        None,
        None,
        None,
        Some(authorized),
    );
    let tx = tx.freeze().expect("freeze");
    let mut bytes = Vec::new();
    tx.write(&mut bytes).expect("write");
    bytes
}

fn orchard_fixture() -> OrchardFixture {
    let (ua, uivk, recipient) = orchard_account([3u8; 32], 0);
    let (other_diversifier_ua, _, _) = orchard_account([3u8; 32], 1);
    let (other_account_ua, other_account_uivk, _) = orchard_account([4u8; 32], 0);
    let bytes = build_orchard_tx(recipient, VALUE, 42);
    OrchardFixture {
        bytes,
        ua,
        uivk,
        other_diversifier_ua,
        other_account_uivk,
        other_account_ua,
    }
}

fn orchard_key(f: &OrchardFixture) -> RecipientViewingKey {
    RecipientViewingKey::parse(&f.uivk, BlinkNetwork::Testnet).expect("parse uivk")
}

/// The Unified *Full* Viewing Key (`uview…`) for the same Orchard account as
/// `orchard_account(seed, index)`. Wallets commonly export this form.
fn orchard_ufvk(seed: [u8; 32]) -> String {
    let sk = SpendingKey::from_bytes(seed).expect("spending key");
    let fvk = FullViewingKey::from(&sk);
    let ufvk = zcash_keys::keys::UnifiedFullViewingKey::new(None, Some(fvk)).expect("build ufvk");
    ufvk.encode(&TEST_NETWORK)
}

// --- Orchard tests ----------------------------------------------------------

#[test]
fn orchard_recipient_and_amount_are_verified() {
    let f = orchard_fixture();

    // The authoritative decoder must see an Orchard bundle.
    let info = blink_zcash::decode_transaction(&f.bytes, Some("nu5")).expect("decode");
    let evidence =
        blink_zcash::inspect_transaction(&f.bytes, Some("nu5"), BlinkNetwork::Testnet, Some(&f.ua))
            .expect("inspect");
    assert!(evidence.pools.orchard, "expected an Orchard bundle");
    assert!(evidence.pools.shielded);

    let key = orchard_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.ua,
        Some(VALUE),
        Some(&info.txid),
    )
    .expect("verify");

    // Correct txid binding.
    assert!(v.txid_matches, "txid must bind to the decoded bytes");
    assert_eq!(v.txid, info.txid);
    // Correct recipient match.
    assert!(v.recipient_verified, "recipient must be verified");
    // Exact received-value recovery.
    assert_eq!(v.recipient_zatoshis, VALUE);
    // Correct amount verification.
    assert!(v.amount_verified, "amount must be verified");
    assert!(v.orchard);
    assert_eq!(v.pools_with_recipient_notes, vec!["orchard".to_string()]);
    assert!(v.key_has_orchard);
    assert!(!v.key_has_sapling);
}

/// A Unified *Full* Viewing Key (`uview…`) — the form wallets most commonly
/// export — must verify a shielded payment exactly as the Unified Incoming
/// Viewing Key does. The full key's incoming-viewing form is derived internally.
#[test]
fn orchard_unified_full_viewing_key_verifies_identically() {
    let f = orchard_fixture();
    let info = blink_zcash::decode_transaction(&f.bytes, Some("nu5")).expect("decode");

    let ufvk = orchard_ufvk([3u8; 32]);
    assert!(
        ufvk.starts_with("uviewtest") || ufvk.starts_with("uvftest"),
        "expected a UFVK encoding, got {ufvk}"
    );

    let key = RecipientViewingKey::parse(&ufvk, BlinkNetwork::Testnet).expect("parse ufvk");
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.ua,
        Some(VALUE),
        Some(&info.txid),
    )
    .expect("verify");

    assert!(v.txid_matches);
    assert!(v.recipient_verified, "UFVK must verify the recipient");
    assert_eq!(v.recipient_zatoshis, VALUE);
    assert!(v.amount_verified, "UFVK must verify the amount");
    assert!(v.key_has_orchard);
    assert!(!v.key_has_sapling);
}

/// A UFVK for a different account must not credit the requested recipient.
#[test]
fn orchard_unified_full_viewing_key_for_other_account_is_not_credited() {
    let f = orchard_fixture();
    let info = blink_zcash::decode_transaction(&f.bytes, Some("nu5")).expect("decode");

    let other = orchard_ufvk([4u8; 32]);
    let key = RecipientViewingKey::parse(&other, BlinkNetwork::Testnet).expect("parse ufvk");
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.ua,
        Some(VALUE),
        Some(&info.txid),
    )
    .expect("verify");

    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
    assert!(!v.amount_verified);
}

#[test]
fn orchard_wrong_diversified_address_under_same_key_is_not_verified() {
    let f = orchard_fixture();
    let key = orchard_key(&f);
    // The note decrypts with this key, but it pays a *different* diversified
    // address derived from the same account, so it must not be credited.
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.other_diversifier_ua,
        Some(VALUE),
        None,
    )
    .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
    assert!(!v.amount_verified);
}

#[test]
fn orchard_incorrect_requested_amount_is_not_verified() {
    let f = orchard_fixture();
    let key = orchard_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.ua,
        Some(VALUE + 1),
        None,
    )
    .expect("verify");
    // The recipient still matches; the amount does not.
    assert!(v.recipient_verified);
    assert!(!v.amount_verified);
    assert_eq!(v.recipient_zatoshis, VALUE);
}

#[test]
fn orchard_mismatched_expected_txid_is_not_credited() {
    let f = orchard_fixture();
    let key = orchard_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.ua,
        Some(VALUE),
        Some(&"00".repeat(32)),
    )
    .expect("verify");
    assert!(!v.txid_matches);
    // No recipient credit when the bytes are not the claimed transaction.
    assert!(!v.recipient_verified);
    assert!(!v.amount_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn orchard_wrong_viewing_key_recovers_no_note() {
    let f = orchard_fixture();
    // A key for a different Orchard account cannot decrypt the note.
    let key = RecipientViewingKey::parse(&f.other_account_uivk, BlinkNetwork::Testnet)
        .expect("parse other uivk");
    let v =
        blink_zcash::verify_shielded_payment(&f.bytes, Some("nu5"), &key, &f.ua, Some(VALUE), None)
            .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn orchard_transaction_with_no_eligible_recipient_note_is_not_verified() {
    let f = orchard_fixture();
    let key = orchard_key(&f);
    // The transaction pays account 1, but the request names account 2's address:
    // there is no note to the requested recipient.
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        Some("nu5"),
        &key,
        &f.other_account_ua,
        Some(VALUE),
        None,
    )
    .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn orchard_sapling_only_key_against_orchard_tx_recovers_nothing() {
    let f = orchard_fixture();
    // A Sapling-only viewing key against an Orchard-only transaction.
    let extsk = ExtendedSpendingKey::master(&[9u8; 32]).expect("sapling key");
    let ivk = extsk.to_diversifiable_full_viewing_key().to_external_ivk();
    let sapling_uivk = UnifiedIncomingViewingKey::new(Some(ivk), None, vec![], None, None, vec![])
        .encode(&TEST_NETWORK);
    let key = RecipientViewingKey::parse(&sapling_uivk, BlinkNetwork::Testnet).expect("parse");
    let v =
        blink_zcash::verify_shielded_payment(&f.bytes, Some("nu5"), &key, &f.ua, Some(VALUE), None)
            .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
    assert!(v.key_has_sapling);
    assert!(!v.key_has_orchard);
}

#[test]
fn malformed_orchard_data_is_an_error_not_a_fabricated_match() {
    let f = orchard_fixture();
    let key = orchard_key(&f);
    let err = blink_zcash::verify_shielded_payment(
        &[0x04, 0x00, 0x00],
        None,
        &key,
        &f.ua,
        Some(VALUE),
        None,
    );
    assert!(err.is_err(), "malformed bytes must error, never verify");
}

// --- Sapling fixtures -------------------------------------------------------

struct SaplingFixture {
    bytes: Vec<u8>,
    /// The Sapling payment address the note pays.
    sapling_address: String,
    /// A Sapling-only Unified Address for the same receiver.
    ua: String,
    /// The recipient's Unified Incoming Viewing Key.
    uivk: String,
    /// A viewing key for a different Sapling account.
    other_uivk: String,
    /// A Sapling address for that different account.
    other_address: String,
}

fn sapling_fixture() -> SaplingFixture {
    let mut rng = StdRng::from_seed([7u8; 32]);
    let extsk = ExtendedSpendingKey::master(&[9u8; 32]).expect("master");
    let dfvk = extsk.to_diversifiable_full_viewing_key();
    let (_idx, payment_address) = dfvk.default_address();

    let mut builder = Builder::new(
        Zip212Enforcement::On,
        BundleType::DEFAULT,
        SaplingAnchor::empty_tree(),
    );
    builder
        .add_output(
            None,
            payment_address,
            SaplingNoteValue::from_raw(VALUE),
            [0u8; 512],
        )
        .expect("add_output");

    let (bundle, _meta) = builder
        .build::<MockSpendProver, MockOutputProver, _, ZatBalance>(
            std::slice::from_ref(&extsk),
            &mut rng,
        )
        .expect("build")
        .expect("a bundle");
    let bundle = bundle.create_proofs(&MockSpendProver, &MockOutputProver, &mut rng, ());
    let bundle = bundle
        .apply_signatures(&mut rng, [0u8; 32], &[extsk.expsk().ask().clone()])
        .expect("apply_signatures");

    let tx = TransactionData::from_parts(
        TxVersion::V4,
        BranchId::Sapling,
        0,
        BlockHeight::from_u32(0),
        None,
        None,
        Some(bundle),
        None,
    );
    let tx = tx.freeze().expect("freeze");
    let mut bytes = Vec::new();
    tx.write(&mut bytes).expect("write");

    let sapling_address =
        zcash_address::ZcashAddress::from_sapling(NetworkType::Test, payment_address.to_bytes())
            .encode();
    let ua = zcash_keys::address::UnifiedAddress::from_receivers(
        None,
        Some(payment_address),
        None,
        None,
        None,
    )
    .expect("ua")
    .to_zcash_address(NetworkType::Test)
    .encode();

    let ivk = dfvk.to_external_ivk();
    let uivk = UnifiedIncomingViewingKey::new(Some(ivk), None, vec![], None, None, vec![])
        .encode(&TEST_NETWORK);

    // A different Sapling account.
    let other_extsk = ExtendedSpendingKey::master(&[11u8; 32]).expect("other master");
    let other_dfvk = other_extsk.to_diversifiable_full_viewing_key();
    let (_i, other_addr) = other_dfvk.default_address();
    let other_address =
        zcash_address::ZcashAddress::from_sapling(NetworkType::Test, other_addr.to_bytes())
            .encode();
    let other_uivk = UnifiedIncomingViewingKey::new(
        Some(other_dfvk.to_external_ivk()),
        None,
        vec![],
        None,
        None,
        vec![],
    )
    .encode(&TEST_NETWORK);

    SaplingFixture {
        bytes,
        sapling_address,
        ua,
        uivk,
        other_uivk,
        other_address,
    }
}

fn sapling_key(f: &SaplingFixture) -> RecipientViewingKey {
    RecipientViewingKey::parse(&f.uivk, BlinkNetwork::Testnet).expect("parse uivk")
}

// --- Sapling tests ----------------------------------------------------------

#[test]
fn sapling_recipient_and_amount_are_verified() {
    let f = sapling_fixture();
    let evidence = blink_zcash::inspect_transaction(
        &f.bytes,
        None,
        BlinkNetwork::Testnet,
        Some(&f.sapling_address),
    )
    .expect("inspect");
    assert!(evidence.pools.sapling);
    assert!(evidence.pools.shielded);

    let key = sapling_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        None,
        &key,
        &f.sapling_address,
        Some(VALUE),
        Some(&evidence.txid),
    )
    .expect("verify");
    assert!(v.txid_matches);
    assert!(v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, VALUE);
    assert!(v.amount_verified);
    assert!(v.sapling);
    assert_eq!(v.pools_with_recipient_notes, vec!["sapling".to_string()]);
    assert!(v.key_has_sapling);
}

#[test]
fn sapling_same_receiver_via_unified_address_is_verified() {
    let f = sapling_fixture();
    let key = sapling_key(&f);
    let v = blink_zcash::verify_shielded_payment(&f.bytes, None, &key, &f.ua, Some(VALUE), None)
        .expect("verify");
    assert!(v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, VALUE);
    assert!(v.amount_verified);
}

#[test]
fn sapling_wrong_viewing_key_recovers_no_note() {
    let f = sapling_fixture();
    let key = RecipientViewingKey::parse(&f.other_uivk, BlinkNetwork::Testnet).expect("parse");
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        None,
        &key,
        &f.sapling_address,
        Some(VALUE),
        None,
    )
    .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn sapling_wrong_recipient_is_not_verified() {
    let f = sapling_fixture();
    let key = sapling_key(&f);
    // The correct key, but the request names a different recipient.
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        None,
        &key,
        &f.other_address,
        Some(VALUE),
        None,
    )
    .expect("verify");
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn sapling_wrong_transaction_id_is_not_credited() {
    let f = sapling_fixture();
    let key = sapling_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        None,
        &key,
        &f.sapling_address,
        Some(VALUE),
        Some(&"00".repeat(32)),
    )
    .expect("verify");
    assert!(!v.txid_matches);
    assert!(!v.recipient_verified);
    assert_eq!(v.recipient_zatoshis, 0);
}

#[test]
fn sapling_incorrect_amount_is_not_verified() {
    let f = sapling_fixture();
    let key = sapling_key(&f);
    let v = blink_zcash::verify_shielded_payment(
        &f.bytes,
        None,
        &key,
        &f.sapling_address,
        Some(VALUE + 1),
        None,
    )
    .expect("verify");
    assert!(v.recipient_verified);
    assert!(!v.amount_verified);
    assert_eq!(v.recipient_zatoshis, VALUE);
}

#[test]
fn malformed_sapling_data_is_an_error_not_a_fabricated_match() {
    let f = sapling_fixture();
    let key = sapling_key(&f);
    let err = blink_zcash::verify_shielded_payment(
        &[0x04, 0x00, 0x00],
        None,
        &key,
        &f.sapling_address,
        Some(VALUE),
        None,
    );
    assert!(err.is_err(), "malformed bytes must error, never verify");
}
