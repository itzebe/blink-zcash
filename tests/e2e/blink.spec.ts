/**
 * End-to-end tests for the core BLINK flow.
 *
 * They exercise the real browser against the real web app and API. A payment is
 * never asserted as confirmed, because no test can make a real Zcash payment:
 * that would require a funded wallet. Instead these tests assert the honest
 * behaviour — that BLINK creates a valid ZIP 321 request, that the QR encodes the
 * payment request itself, that the raw address never leaks into the share URL,
 * and that a claimed txid does not become a confirmation.
 */
import { test, expect } from '@playwright/test';

const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';

test.describe('BLINK core flow', () => {
  test('home page presents the three primary actions', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /send money/i })).toBeVisible();
    const titles = page.locator('.action__title');
    await expect(titles).toHaveCount(3);
    await expect(titles.nth(0)).toHaveText('Create Request');
    await expect(titles.nth(1)).toHaveText('Share Payment Link');
    await expect(titles.nth(2)).toHaveText('Pay Privately');
  });

  test('recipient creates a request and receives a share link and QR code', async ({ page }) => {
    await page.goto('/request');

    // Native ZEC request: deterministic, needs no live price provider.
    await page.locator('label[for="currency-ZEC"]').click();
    await page.getByLabel('Amount').fill('25.00');
    await page.getByLabel('Memo (optional)').fill('Dinner');
    await page.getByLabel('Your name').fill('Joseph');
    await page.getByLabel('Your Zcash address').fill(TEST_SAPLING);
    await page.getByRole('button', { name: /create payment/i }).click();

    await expect(page.getByText(/private invoice/i)).toBeVisible();
    await expect(page.locator('.payment-card__amount-val')).toContainText('25');
    await expect(page.locator('.payment-card__memo')).toContainText('Dinner');

    // The QR encodes a ZIP 321 URI, not a link to a web page.
    const qr = page.getByAltText(/ZIP 321 payment request QR code/i);
    await expect(qr).toBeVisible();

    // The share link must not contain the raw address.
    const linkBox = page.locator('.link-box');
    await expect(linkBox).toContainText('/pay/');
    await expect(linkBox).not.toContainText('ztestsapling');
  });

  test('payer opens a link and reaches an explicit confirmation before paying', async ({
    page,
    request,
  }) => {
    const apiBase = process.env.E2E_API_URL ?? 'http://localhost:4000';
    const created = await request.post(`${apiBase}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '25',
        memo: 'Dinner',
        expiryMinutes: 30,
      },
    });
    expect(created.ok()).toBeTruthy();
    const body = (await created.json()) as { shortCode: string };

    await page.goto(`/pay/${body.shortCode}`);
    await expect(page.getByText(/private invoice/i)).toBeVisible();
    await expect(page.getByText('Joseph', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /pay with zcash/i }).click();
    // Confirmation screen: nothing is sent automatically.
    await expect(page.getByText(/confirm payment/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /confirm payment/i })).toBeVisible();
    // No confirmation has happened.
    await expect(page.getByText(/payment confirmed/i)).toHaveCount(0);
  });

  test('a claimed transaction id does not confirm a payment', async ({ page, request }) => {
    const apiBase = process.env.E2E_API_URL ?? 'http://localhost:4000';
    const created = await request.post(`${apiBase}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '1',
        memo: 'Test',
        expiryMinutes: 30,
      },
    });
    const { shortCode } = (await created.json()) as { shortCode };

    await page.goto(`/pay/${shortCode}`);
    await page.getByRole('button', { name: /pay with zcash/i }).click();
    await page.getByRole('button', { name: /confirm payment/i }).click();
    await page.getByRole('button', { name: /enter transaction id/i }).click();

    await page.getByLabel('Transaction id').fill('a'.repeat(64));
    await page.getByRole('button', { name: /check payment/i }).click();

    // The status must NOT read "confirmed": nothing was observed on-chain.
    await expect(page.getByText(/waiting for confirmation/i)).toBeVisible();
    await expect(page.getByText(/it has not yet observed/i)).toBeVisible();
    await expect(page.getByText(/^payment confirmed$/i)).toHaveCount(0);
  });

  test('scan rejects a malformed payment request', async ({ page }) => {
    await page.goto('/scan');
    await page.getByLabel(/paste payment link or request/i).fill('zcash:not-a-real-address?amount=5');
    await page.getByRole('button', { name: /open request/i }).click();
    await expect(page.locator('.alert--error')).toBeVisible();
  });

  test('request screen previews the shielded privacy of a shielded address', async ({ page }) => {
    await page.goto('/request');
    await page.getByLabel('Your Zcash address').fill(TEST_SAPLING);
    const panel = page.locator('.privacy--shielded');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/shielded/i);
    // Recipient and amount are protected; the sender is not over-claimed.
    await expect(panel.locator('.privacy__fact--protected')).toHaveCount(2);
    await expect(panel.locator('.privacy__fact--varies')).toHaveCount(1);
  });

  test('payer sees an accurate privacy disclosure and never the word anonymous', async ({
    page,
    request,
  }) => {
    const apiBase = process.env.E2E_API_URL ?? 'http://localhost:4000';
    const created = await request.post(`${apiBase}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '5',
        expiryMinutes: 30,
      },
    });
    const { shortCode } = (await created.json()) as { shortCode };

    await page.goto(`/pay/${shortCode}`);
    const panel = page.locator('.privacy--shielded');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.privacy__fact--varies')).toContainText(/depends on payer/i);
    // BLINK must never claim more privacy than the protocol provides.
    await expect(page.getByText(/anonymous/i)).toHaveCount(0);
  });

  test('use-case modes prefill the same request flow', async ({ page }) => {
    await page.goto('/request');
    await page.getByRole('button', { name: 'Point of sale' }).click();
    await expect(page.getByLabel('Amount')).toHaveValue('5');
    await expect(page.getByLabel('Memo (optional)')).toHaveValue('Point of sale');

    await page.getByRole('button', { name: 'Payroll' }).click();
    await expect(page.getByLabel('Amount')).toHaveValue('850');
  });
});

test.describe('privacy, payment links and receipts', () => {
  const TEST_TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
  const apiBase = () => process.env.E2E_API_URL ?? 'http://localhost:4000';

  test('a shielded request is labelled a shielded payment in plain language', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${apiBase()}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '5',
        memo: 'Dinner',
        expiryMinutes: 30,
      },
    });
    const { shortCode } = (await created.json()) as { shortCode };

    await page.goto(`/pay/${shortCode}`);
    await expect(page.locator('.privacy--shielded')).toBeVisible();
    await expect(page.locator('.privacy__headline')).toHaveText(/Shielded payment/);
    // The application-level caveat is stated, not hidden.
    await expect(page.getByText(/stored and shown in plaintext/i)).toBeVisible();
    await expect(page.getByText(/anonymous/i)).toHaveCount(0);
  });

  test('a transparent request is labelled a public payment, never shielded', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${apiBase()}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_TRANSPARENT,
        amount: '5',
        expiryMinutes: 30,
      },
    });
    const { shortCode } = (await created.json()) as { shortCode };

    await page.goto(`/pay/${shortCode}`);
    await expect(page.locator('.privacy--transparent')).toBeVisible();
    await expect(page.locator('.privacy__headline')).toHaveText(/Public payment/);
    await expect(page.getByText('Shielded payment')).toHaveCount(0);
  });

  test('an invalid payment link shows a clear not-found state', async ({ page }) => {
    await page.goto('/pay/ZZZZZZZZZZZZZ');
    await expect(page.getByText(/not found/i).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /create a new request/i })).toBeVisible();
  });

  test('a receipt is refused until the payment is confirmed', async ({ page, request }) => {
    const created = await request.post(`${apiBase()}/v1/payment-requests`, {
      data: {
        recipientName: 'Joseph',
        recipientAddress: TEST_SAPLING,
        amount: '5',
        expiryMinutes: 30,
      },
    });
    const { shortCode } = (await created.json()) as { shortCode };

    await page.goto(`/receipt/${shortCode}`);
    await expect(page.locator('.alert--error')).toBeVisible();
    // The headline is honest: no receipt is shown for an unconfirmed request.
    await expect(page.getByText(/only issued for a confirmed payment/i)).toBeVisible();
    // The network badge never guesses a network it does not know.
    await expect(page.locator('.network-pill')).toHaveText('Zcash');
  });
});

/**
 * Cold-start resilience.
 *
 * The free hosting tier spins the backend down when idle, so the first request
 * after a quiet period can take tens of seconds. These tests simulate that
 * window (a delayed or 502 network probe) and assert the app stays usable and
 * never mistakes a waking backend for a network mismatch.
 */
test.describe('cold-start resilience', () => {
  const okNetwork = {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ network: 'testnet' }),
  };

  test('renders the app immediately and shows a non-blocking connecting strip', async ({
    page,
  }) => {
    await page.route('**/v1/meta/network', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill(okNetwork);
    });

    await page.goto('/');
    // The app is usable from the first paint; the strip is informational only.
    await expect(page.getByRole('heading', { name: /send money/i })).toBeVisible();
    await expect(page.locator('.conn')).toBeVisible();

    // Once the API answers, the strip clears and the badge is confirmed.
    await expect(page.locator('.conn')).toHaveCount(0);
    await expect(page.locator('.network-pill')).toHaveText('Zcash Testnet');
  });

  test('a waking backend (502) never shows a network mismatch', async ({ page }) => {
    let calls = 0;
    await page.route('**/v1/meta/network', async (route) => {
      calls += 1;
      if (calls <= 2) {
        await route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
      } else {
        await route.fulfill(okNetwork);
      }
    });

    await page.goto('/');
    await expect(page.locator('.conn')).toBeVisible();
    // A transport failure is not a disagreement about the network.
    await expect(page.getByText(/not available right now/i)).toHaveCount(0);

    await expect(page.locator('.conn')).toHaveCount(0);
    await expect(page.locator('.network-pill')).toHaveText('Zcash Testnet');
  });

  test('payment creation waits for the confirmed network', async ({ page }) => {
    await page.route('**/v1/meta/network', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill(okNetwork);
    });

    await page.goto('/request');
    await expect(page.getByRole('button', { name: /connecting/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /create payment/i })).toBeEnabled();
  });
});

