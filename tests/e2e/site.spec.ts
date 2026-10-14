/**
 * Tests for the site chrome and the litepaper.
 *
 * These cover the parts added in the redesign: the shared header and footer,
 * the litepaper page and its table of contents, mobile navigation, and
 * responsive rendering. They drive the real app in a real browser.
 */
import { test, expect } from '@playwright/test';

test.describe('litepaper', () => {
  test('is reachable from the home page hero', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Read the Litepaper' }).click();
    await expect(page).toHaveURL(/\/litepaper$/);
    await expect(
      page.getByRole('heading', { level: 1, name: /private zcash payment requests/i }),
    ).toBeVisible();
  });

  test('renders every required section', async ({ page }) => {
    await page.goto('/litepaper');
    for (const heading of [
      /executive summary/i,
      /the problem/i,
      /the blink solution/i,
      /product architecture/i,
      /how blink works/i,
      /shielded-first privacy model/i,
      /transaction verification and trust boundaries/i,
      /security and data handling/i,
      /technology stack/i,
      /use cases/i,
      /current limitations/i,
      /roadmap/i,
      /conclusion/i,
      /project resources/i,
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('the table of contents links to real sections', async ({ page }) => {
    await page.goto('/litepaper');
    const toc = page.locator('.doc__toc');
    await expect(toc).toBeVisible();
    // Every table-of-contents link must resolve to an element on the page.
    const hrefs = await toc.locator('a').evaluateAll((links) =>
      links.map((l) => l.getAttribute('href') ?? ''),
    );
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(href.startsWith('#')).toBeTruthy();
      await expect(page.locator(href)).toHaveCount(1);
    }
    // Following a link moves to that section.
    await toc.getByRole('link', { name: /verification and trust boundaries/i }).click();
    await expect(page).toHaveURL(/#verification$/);
  });

  test('states the shielded-first limit honestly and shows no fabricated claims', async ({
    page,
  }) => {
    await page.goto('/litepaper');
    const body = page.locator('.doc');
    // The central honesty claim: a shielded address is not proof of a shielded payment.
    await expect(body).toContainText(/does not, by itself, prove/i);
    // The verification boundary is stated, not hidden.
    await expect(body).toContainText(/cannot prove from public data/i);
    // It must not overclaim privacy for the whole payment.
    await expect(body).not.toContainText(/fully anonymous|completely anonymous|guaranteed anonymity/i);
    // No invented tokenomics, token, or governance material.
    await expect(page.getByRole('heading', { name: /tokenomics|token sale|governance/i })).toHaveCount(0);
    await expect(body).not.toContainText(/BLINK token|token sale|tokenomics/i);
  });

  test('has a last-updated date and working resource links', async ({ page }) => {
    await page.goto('/litepaper');
    await expect(page.locator('.doc__meta')).toContainText(/last updated:/i);
    const repo = page.getByRole('link', { name: /github.com\/itzebe\/blink-zcash/i });
    await expect(repo).toHaveAttribute('href', 'https://github.com/itzebe/blink-zcash');
  });
});

test.describe('navigation and footer', () => {
  test('the header navigation reaches every primary page', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('.app-nav');
    for (const [label, path] of [
      ['Create request', '/request'],
      ['Check a request', '/scan'],
      ['Litepaper', '/litepaper'],
      ['Home', '/'],
    ] as const) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}$`));
      await page.goto('/');
    }
  });

  test('the footer links point at real pages and the repository', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('.app-footer');
    await expect(footer).toBeVisible();
    await expect(
      footer.getByRole('link', { name: /create a payment request/i }),
    ).toHaveAttribute('href', '/request');
    await expect(footer.getByRole('link', { name: /check a payment request/i })).toHaveAttribute(
      'href',
      '/scan',
    );
    await expect(footer.getByRole('link', { name: /litepaper/i })).toHaveAttribute(
      'href',
      '/litepaper',
    );
    await expect(footer.getByRole('link', { name: /source code on github/i })).toHaveAttribute(
      'href',
      'https://github.com/itzebe/blink-zcash',
    );
  });

  test('internal footer links do not lead to missing pages', async ({ page }) => {
    await page.goto('/');
    for (const path of ['/request', '/scan', '/litepaper']) {
      const res = await page.request.get(path);
      expect(res.status(), `expected ${path} to resolve`).toBeLessThan(400);
    }
  });

  test('robots.txt disallows payment links and receipts', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('Disallow: /pay/');
    expect(body).toContain('Disallow: /receipt/');
    expect(body).toContain('/sitemap.xml');
  });

  test('the sitemap lists the public pages and no private ones', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('/litepaper');
    expect(body).not.toContain('/pay/');
    expect(body).not.toContain('/receipt/');
  });

  test('a payment link is marked noindex', async ({ request }) => {
    const created = await request.post('http://localhost:4000/v1/payment-requests', {
      data: {
        recipientName: 'Joseph',
        recipientAddress:
          'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez',
        amount: '1.5',
        memo: 'Test',
        expiryMinutes: 30,
      },
    });
    expect(created.ok()).toBeTruthy();
    const { shortCode } = (await created.json()) as { shortCode: string };
    const res = await request.get(`/pay/${shortCode}`);
    const html = await res.text();
    expect(html).toMatch(/noindex/i);
    // The raw recipient address never appears in the served page.
    expect(html).not.toContain('ztestsapling1');
  });
});

test.describe('responsive and accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the mobile menu opens and navigates', async ({ page }) => {
    await page.goto('/');
    // On a phone the nav is collapsed behind a toggle.
    const toggle = page.getByRole('button', { name: /menu/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    // The toggle keeps the same accessible name, so its expanded state is the
    // stable signal.
    await expect(page.getByRole('button', { name: /menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const litepaper = page.locator('.app-nav').getByRole('link', { name: 'Litepaper' });
    await expect(litepaper).toBeVisible();

    await litepaper.click();
    await expect(page).toHaveURL(/\/litepaper$/);
  });

  test('the home page and litepaper are usable at a mobile width', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a payment request' }).first()).toBeVisible();

    await page.goto('/litepaper');
    await expect(page.locator('.doc__toc')).toBeVisible();
    // The primary action on the page is still reachable.
    await expect(page.getByRole('heading', { name: /executive summary/i })).toBeVisible();
  });

  test('the request form is operable on a small screen', async ({ page }) => {
    await page.goto('/request');
    await expect(page.getByLabel('Amount')).toBeVisible();
    await page.getByLabel('Amount').fill('1.5');
    await expect(page.getByLabel('Amount')).toHaveValue('1.5');
    await expect(page.getByRole('button', { name: /create payment/i })).toBeVisible();
  });
});
