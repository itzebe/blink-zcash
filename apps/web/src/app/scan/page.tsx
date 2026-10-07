'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import jsQR from 'jsqr';
import { Shell, TopBar, Alert, Row } from '@/components/Shell';
import { useConnection } from '@/components/ConnectionProvider';
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

/**
 * Parse a scanned or pasted payload.
 *
 * A BLINK short link is resolved to its payment request. A raw ZIP 321 URI is
 * validated and displayed for confirmation — never auto-paid. Validation runs in
 * the browser for immediate feedback AND again on the server before anything is
 * acted upon.
 */
function parseInput(raw: string, network: 'testnet' | 'mainnet' | null): Parsed {
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
    // Only enforce a network mismatch once the API has confirmed which network we
    // are on. Before that, `network` is null and the check is deferred to the
    // server, which always validates authoritatively.
    if (network && parsedAddress.network !== network) {
      networkError = `This request is for ${parsedAddress.network}, but this app is configured for ${network}.`;
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
  const { network } = useConnection();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const animFrameRef = useRef<number | null>(null);

  function handleRawPayload(raw: string) {
    setError(null);
    setResult(null);
    try {
      const parsed = parseInput(raw, network);
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

  function handleParse(event: React.FormEvent) {
    event.preventDefault();
    handleRawPayload(input);
  }

  async function handleGalleryImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);

    // 1. Try BarcodeDetector if natively available
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        const BarcodeDetectorClass = (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (bitmap: ImageBitmap) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
        const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
        const bitmap = await createImageBitmap(file);
        const barcodes = await detector.detect(bitmap);
        if (barcodes.length > 0 && barcodes[0].rawValue) {
          setInput(barcodes[0].rawValue);
          handleRawPayload(barcodes[0].rawValue);
          return;
        }
      } catch {
        /* fallback to canvas jsQR */
      }
    }

    // 2. Canvas fallback with jsQR
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setError('Could not process image canvas.');
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          setInput(code.data);
          handleRawPayload(code.data);
        } else {
          setError('No QR code found in selected photo. Try another image or paste the link.');
        }
      };
      img.onerror = () => setError('Could not load image file.');
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  async function startCameraScanner() {
    setError(null);
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        scanVideoLoop();
      }
    } catch (err) {
      setScanning(false);
      setError(
        err instanceof Error
          ? `Camera access error: ${err.message}`
          : 'Could not access camera. Try selecting a QR photo from gallery instead.',
      );
    }
  }

  function stopCameraScanner() {
    setScanning(false);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
  }

  function scanVideoLoop() {
    if (!videoRef.current || videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanVideoLoop);
      return;
    }

    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        stopCameraScanner();
        setInput(code.data);
        handleRawPayload(code.data);
        return;
      }
    }
    animFrameRef.current = requestAnimationFrame(scanVideoLoop);
  }

  return (
    <Shell>
      <TopBar network={network} />
      <form className="stack" onSubmit={handleParse}>
        <div className="stack stack--sm" style={{ textAlign: 'center' }}>
          <p className="kicker">Check a payment request</p>
          <h1>Scan or paste a BLINK request</h1>
          <p className="lede">
            Scan a BLINK QR, or paste a BLINK link or ZIP 321 payment request. Nothing is paid until
            you confirm.
          </p>
        </div>

        {/* Elegant Scanner Frame / Video View */}
        <div className="card card--accent center" style={{ padding: '24px 20px', background: 'var(--surface-solid)' }}>
          {scanning ? (
            <div style={{ position: 'relative', borderRadius: 20, overflow: 'hidden', margin: '0 auto 16px', maxWidth: 280 }}>
              <video ref={videoRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
              <button
                type="button"
                className="btn btn--danger btn--small"
                onClick={stopCameraScanner}
                style={{ position: 'absolute', bottom: 12, right: 12 }}
              >
                Stop Camera
              </button>
            </div>
          ) : (
            <div
              style={{
                width: 180,
                height: 180,
                margin: '0 auto 16px',
                borderRadius: 20,
                border: '2px dashed var(--accent)',
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 0 30px var(--accent-glow)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <span style={{ fontSize: 48, opacity: 0.8 }}>▣</span>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 12 }}>
            {!scanning ? (
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={startCameraScanner}
              >
                Start camera
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleGalleryImage}
            />
          </div>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        <div className="field">
          <label className="field__label" htmlFor="payload">
            Paste payment link or request
          </label>
          <textarea
            id="payload"
            className="textarea input--mono"
            placeholder={'https://<this-host>/pay/8K4Q2X\nor zcash:u1…?amount=25&memo=…'}
            spellCheck={false}
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>

        <button className="btn btn--primary" type="submit" disabled={!input.trim()}>
          {result ? 'Parse again' : 'Open request'}
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
            <p className="tiny muted" style={{ marginTop: 4 }}>
              ZIP 321 amounts are ZEC. A raw request carries no USD value, so none is shown.
            </p>
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
