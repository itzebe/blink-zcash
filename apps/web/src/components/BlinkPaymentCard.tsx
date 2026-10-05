'use client';

import { ReactNode } from 'react';
import { QrCode } from './QrCode';
import { StatusBadge } from './Shell';

export interface BlinkPaymentCardProps {
  amount: string;
  currency?: string;
  memo?: string | null;
  recipientName?: string | null;
  network?: 'testnet' | 'mainnet';
  status?: string;
  statusLabel?: string;
  statusTone?: string;
  zip321Uri?: string | null;
  shareUrl?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}

export function BlinkPaymentCard({
  amount,
  currency = 'ZEC',
  memo,
  recipientName,
  network = 'testnet',
  status,
  statusLabel: label,
  statusTone: tone,
  zip321Uri,
  shareUrl,
  actions,
  children,
}: BlinkPaymentCardProps) {
  return (
    <div className="payment-card">
      <div className="payment-card__header">
        <div className="payment-card__brand">
          <span>BLINK</span>
        </div>
        <div className="payment-card__privacy-tag">
          <span>{network === 'mainnet' ? 'Zcash Mainnet' : 'Protected by Zcash'}</span>
        </div>
      </div>

      <div className="payment-card__amount-container">
        <div className="payment-card__amount-val">
          {amount}
          <span className="payment-card__amount-symbol">{currency}</span>
        </div>
      </div>

      {memo ? <div className="payment-card__memo">“{memo}”</div> : null}

      {recipientName ? (
        <div className="row" style={{ paddingTop: 0 }}>
          <span className="row__label">Recipient</span>
          <span className="row__value">{recipientName}</span>
        </div>
      ) : null}

      {status && label && tone ? (
        <div className="row">
          <span className="row__label">Status</span>
          <span className="row__value">
            <StatusBadge status={status} label={label} tone={tone} />
          </span>
        </div>
      ) : null}

      {zip321Uri ? (
        <div style={{ marginTop: 20, marginBottom: 20 }}>
          <QrCode value={zip321Uri} label="ZIP 321 payment request QR code" />
        </div>
      ) : null}

      {shareUrl ? <div className="link-box" style={{ marginBottom: 16 }}>{shareUrl}</div> : null}

      {actions ? <div className="btn-row">{actions}</div> : null}

      {children}
    </div>
  );
}
