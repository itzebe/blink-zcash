//! Authoritative transaction-decoding tests.
//!
//! The fixture is the `tx_read_write` vector from the official `zcash_primitives`
//! crate's own test suite: a real transaction from Zcash **testnet** block
//! 280003 with a known txid. If our decoding disagreed with the official
//! implementation, this test would fail, which is the point: BLINK must not
//! invent a txid-decoding rule of its own.

use blink_zcash::decode_transaction;

const TESTNET_TXID: &str = "64f0bd7fe30ce23753358fe3a2dc835b8fba9c0274c4e2c54a6f73114cb55639";

fn fixture_bytes() -> Vec<u8> {
    let hex = include_str!("data/tx_read_write.hex").trim();
    hex.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn decodes_real_testnet_transaction_to_expected_txid() {
    let bytes = fixture_bytes();
    assert_eq!(bytes.len(), 2005);

    let info = decode_transaction(&bytes, None).expect("decodes");
    assert_eq!(info.txid, TESTNET_TXID);
    assert_eq!(info.size, 2005);
}

#[test]
fn decodes_with_explicit_branch() {
    let bytes = fixture_bytes();
    let info = decode_transaction(&bytes, Some("sapling")).expect("decodes");
    assert_eq!(info.txid, TESTNET_TXID);
}

#[test]
fn rejects_unknown_branch() {
    let bytes = fixture_bytes();
    let err = decode_transaction(&bytes, Some("spaceship")).unwrap_err();
    assert!(err.to_string().contains("unknown branch"));
}

#[test]
fn rejects_malformed_bytes() {
    // Truncated input must error, never yield a fabricated txid.
    let err = decode_transaction(&[0x04, 0x00, 0x00], None).unwrap_err();
    assert!(err.to_string().contains("could not decode"));
}

#[test]
fn rejects_empty_input() {
    assert!(decode_transaction(&[], None).is_err());
}
