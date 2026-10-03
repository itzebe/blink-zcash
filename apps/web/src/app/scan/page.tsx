'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell, TopBar, Alert, Row } from '@/components/Shell';
import { parseSinglePayment, Zip321Error } from '@blink/payment-request';
import { parseAddress, type ParsedAddress } from '@blink/zcash';

type Parsed =
  | { kind: 'blink'; shortCode: string }
  | {
      kind: 'zip321';
      address: string;
      amount: string | null;
      memo: string | null;
      message: string | null;
      label: string | null;
      parsedAddress: ParsedAddress | null;
      networkError: string | null;
    };

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

/**
 * Parse a scanned or pasted payload.
 *
 * A BLINK short link is resolved to its payment request. A raw ZIP 321 URI is
 * validated and displayed for confirmation — never auto-paid. Validation runs in
 * the browser for immediate feedback AND again on the server before anything is
 * acted upon.
 */
function parseInput(raw: string): Parsed {
  const value = raw.trim();

  const blinkMatch = value.match(/\/pay\/([A-Z0-9]{6,32})/i);
  if (blinkMatch && !value.toLowerCase().startsWith('zcash:')) {
    return { kind: 'blink', shortCode: blinkMatch[1]!.toUpperCase() };
  }

  const payment = parseSinglePayment(value);
  let parsedAddress: ParsedAddress | null = null;
  let networkError: string | null = null;
  try {
    parsedAddress = parseAddress(payment.address);
    if (parsedAddress.network !== NETWORK) {
      networkError = `This request is for ${parsedAddress.network}, but this app is configured for ${NETWORK}.`;
    }
  } catch (err) {
    networkError = err instanceof Error ? err.message : 'Address could not be validated.';
  }

  return {
    kind: 'zip321',
    address: payment.address,
    amount: payment.amount ?? null,
    memo: payment.memo ?? null,
    message: payment.message ?? null,
    label: payment.label ?? null,
    parsedAddress,
    networkError,
  };
}

export default function ScanPage() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleParse(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      const parsed = parseInput(input);
      if (parsed.kind === 'blink') {
        router.push(`/pay/${parsed.shortCode}`);
        return;
      }
      setResult(parsed);
    } catch (err) {
      if (err instanceof Zip321Error) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'That does not look like a payment request.');
      }
    }
  }

  return (
    <Shell>
      <TopBar network={NETWORK} />
      <form className="stack" onSubmit={handleParse}>
        <div className="stack stack--sm">
          <p className="kicker">Scan or paste</p>
          <h1>Open a payment request.</h1>
          <p className="lede">
            Paste a BLINK link or a ZIP 321 payment request. Nothing is paid until you confirm.
          </p>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        <div className="field">
          <label className="field__label" htmlFor="payload">
            Payment link or request
          </label>
          <textarea
            id="payload"
            className="textarea input--mono"
            placeholder={'blink.app/pay/8K4Q2X\nor zcash:u1…?amount=25&memo=…'}
            spellCheck={false}
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>

        <button className="btn btn--primary" type="submit" disabled={!input.trim()}>
          {result ? 'Parse again' : 'Read request'}
        </button>
      </form>

      {result && result.kind === 'zip321' ? (
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="card card--accent">
            <p className="kicker">Payment request</p>
            <h2 className="amount-hero" style={{ fontSize: 40, marginTop: 8 }}>
              {result.amount ?? '—'}
              <span>ZEC</span>
            </h2>
            <div style={{ marginTop: 12 }}>
              {result.label ? <Row label="Label">{result.label}</Row> : null}
              {result.memo ? <Row label="Memo">{result.memo}</Row> : null}
              {result.message ? <Row label="Message">{result.message}</Row> : null}
              <Row label="Address type">{result.parsedAddress?.kind ?? 'unknown'}</Row>
              <Row label="Network">{result.parsedAddress?.network ?? 'unknown'}</Row>
            </div>
          </div>

          {result.networkError ? (
            <Alert kind="error">{result.networkError}</Alert>
          ) : (
            <Alert kind="warn">
              BLINK cannot pay this directly — it is a raw request, not a BLINK link. Open it in a
              compatible Zcash wallet to approve the payment.
            </Alert>
          )}

          <details className="tech">
            <summary>View technical details</summary>
            <div className="tech__body">
              <div>{result.address}</div>
            </div>
          </details>
        </div>
      ) : null}

      <p className="footer-note">Scanning never sends funds automatically</p>
    </Shell>
  );
}
