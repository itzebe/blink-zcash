'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders a QR code for the given ZIP 321 payment URI.
 *
 * The encoded payload is the `zcash:` payment request itself, not a link to a
 * web page. A compatible wallet can scan it and construct the payment directly.
 */
export function QrCode({
  value,
  size = 240,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#07080a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not render the QR code.');
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) {
    return <p className="alert alert--error">{error}</p>;
  }

  return (
    <div className="qr-frame">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={label ?? 'ZIP 321 payment request QR code'}
          width={size}
          height={size}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{ width: size, height: size, background: '#111', borderRadius: 8 }}
        />
      )}
    </div>
  );
}
