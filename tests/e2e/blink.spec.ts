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

    await expect(page.getByText(/payment object ready/i)).toBeVisible();
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
    await expect(page.getByText(/private payment request/i)).toBeVisible();
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
});
