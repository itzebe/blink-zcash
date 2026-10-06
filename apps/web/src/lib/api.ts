/**
 * Browser-side client for the BLINK API.
 *
 * The web app never handles private keys, seed phrases or spending keys. It
 * creates payment requests, renders ZIP 321 URIs, and hands the payer off to a
 * wallet. All blockchain state shown here comes from the API, which in turn only
 * reports what a verification provider actually observed.
 */

import type { PrivacyCapability, PaymentPurpose } from '@blink/shared';

export interface PublicPaymentRequest {
  shortCode: string;
  recipientName: string;
  /** Settlement amount in ZEC (the value ZIP 321 carries). */
  amount: string;
  /** Always "ZEC": ZIP 321 amounts are ZEC-denominated. */
  currency: 'ZEC';
  /** Original requested amount in USD, or null for a native ZEC request. */
  usdAmount: string | null;
  /** ZEC/USD price used at creation, or null for a native ZEC request. */
  zecUsdPrice: string | null;
  priceProvider: string | null;
  priceObservedAt: string | null;
  /** Everyday workflow this request belongs to (invoice, payroll, …). */
  purpose: PaymentPurpose;
  memo: string | null;
  network: 'testnet' | 'mainnet';
  status: string;
  confirmations: number;
  txidShort: string | null;
  /** Protocol-accurate privacy capability of the route (from the address kind). */
  privacy: PrivacyCapability;
  expiresAt: string;
  createdAt: string;
}

/** Normalized ZEC/USD price returned by the API (never contains the API key). */
export interface ZecUsdPrice {
  provider: string;
  asset: 'ZEC';
  quote: 'USD';
  price: string;
  observedAt: string | null;
}

export interface CreatedPaymentRequest {
  shortCode: string;
  shareUrl: string;
  zip321Uri: string;
  request: PublicPaymentRequest;
  managementToken: string;
}

export interface PaymentDetails {
  shortCode: string;
  zip321Uri: string;
  addressKind: string | null;
  addressFingerprint: string | null;
  network: 'testnet' | 'mainnet';
  privacy: PrivacyCapability;
  status: string;
  expiresAt: string;
}

export interface VerificationResult {
  observed: boolean;
  provider: string;
  confirmations: number;
  status: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, '');
  }
  return '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(
      typeof json.message === 'string' ? json.message : 'request failed',
      typeof json.error === 'string' ? json.error : 'error',
      res.status,
    );
  }
  return json as T;
}

export interface CreateInput {
  recipientName: string;
  recipientAddress: string;
  /**
   * Requested amount. Interpreted according to `currency`: a ZEC decimal string
   * for `'ZEC'` (default), or a USD decimal string for `'USD'` — in which case
   * the server converts it to ZEC at a live price.
   */
  amount: string;
  currency?: 'ZEC' | 'USD';
  /** Everyday workflow label. Presentation metadata; defaults to `invoice`. */
  purpose?: PaymentPurpose;
  memo?: string;
  expiryMinutes: number;
}

export const api = {
  createPaymentRequest(input: CreateInput): Promise<CreatedPaymentRequest> {
    return request<CreatedPaymentRequest>('/v1/payment-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** Current ZEC/USD price for the Request screen preview. */
  getZecUsdPrice(): Promise<{ price: ZecUsdPrice }> {
    return request<{ price: ZecUsdPrice }>('/v1/price/zec-usd');
  },

  /** Authoritative network identity, used by the fail-closed network guard. */
  getNetwork(): Promise<{ network: 'testnet' | 'mainnet'; verificationProvider: string; priceProvider: string }> {
    return request('/v1/meta/network');
  },

  getPaymentRequest(shortCode: string): Promise<{ request: PublicPaymentRequest }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}`);
  },

  getPaymentDetails(shortCode: string): Promise<PaymentDetails> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/payment-details`);
  },

  initiate(shortCode: string): Promise<{ request: PublicPaymentRequest }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/initiate`, {
      method: 'POST',
      body: '{}',
    });
  },

  claimTxid(
    shortCode: string,
    txid: string,
  ): Promise<{ request: PublicPaymentRequest; note: string }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ txid }),
    });
  },

  verify(
    shortCode: string,
  ): Promise<{ request: PublicPaymentRequest; verification: VerificationResult }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/verify`, {
      method: 'POST',
      body: '{}',
    });
  },

  cancel(shortCode: string, managementToken: string): Promise<{ request: PublicPaymentRequest }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/cancel`, {
      method: 'POST',
      headers: { 'x-blink-management-token': managementToken },
      body: '{}',
    });
  },

  receipt(shortCode: string): Promise<{ receipt: Receipt }> {
    return request(`/v1/payment-requests/${encodeURIComponent(shortCode)}/receipt`);
  },
};

export interface Receipt {
  shortCode: string;
  amount: string;
  currency: string;
  /** Original requested amount in USD, or null for a native ZEC request. */
  usdAmount: string | null;
  /** ZEC/USD price used at creation, or null for a native ZEC request. */
  zecUsdPrice: string | null;
  /** Everyday workflow this request belongs to. */
  purpose: PaymentPurpose;
  memo: string | null;
  network: 'testnet' | 'mainnet';
  privacy: PrivacyCapability;
  status: string;
  txid: string | null;
  confirmations: number;
  paidAt: string;
  statement: string;
}
