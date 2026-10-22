import { expect, test, type Page } from '@playwright/test';

const AURORA_DESCRIPTION = 'A warm dimmable desk lamp with a brushed brass arm.';

function product(page: Page, name: string | RegExp) {
  return page.getByTestId('product-list').getByRole('button', { name });
}

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/');
  // Keep the pointer away from product cards so hover prefetches cannot start
  // unless a test asks for one explicitly.
  await page.mouse.move(0, 0);
  await expect(page.getByTestId('product-list')).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('1');
}

test('loads the catalog once and renders four products', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Loading the catalog…')).toBeVisible();
  await expect(page.getByTestId('product-list')).toBeVisible();
  await expect(page.getByTestId('product-list').getByRole('listitem')).toHaveCount(4);
  await expect(page.getByTestId('stat-requests')).toHaveText('1');
});

test('prefetches a product on hover before navigation', async ({ page }) => {
  await openCatalog(page);
  const aurora = product(page, /Aurora Lamp/);

  await aurora.hover();
  // The prefetch starts before navigation, so it is the second request.
  await expect(page.getByTestId('stat-requests')).toHaveText('2');
  await expect(page.getByTestId('product-list')).toBeVisible();

  await aurora.click();
  await expect(page.getByText(AURORA_DESCRIPTION)).toBeVisible();
  // The detail view joined the prefetch instead of starting a third request.
  await expect(page.getByTestId('stat-requests')).toHaveText('2');
  await expect(page.getByTestId('stat-prefetch')).toHaveText('1');
});

test('reuses cached data when navigating away and back', async ({ page }) => {
  await openCatalog(page);

  await product(page, /Aurora Lamp/).click();
  await expect(page.getByText(AURORA_DESCRIPTION)).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('2');

  await page.getByRole('button', { name: '← Back to catalog' }).click();
  await expect(page.getByTestId('product-list')).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('2');

  await product(page, /Aurora Lamp/).click();
  await expect(page.getByText(AURORA_DESCRIPTION)).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('2');
});

test('shows a fresh loading state when the query key changes', async ({ page }) => {
  await openCatalog(page);
  await product(page, /Aurora Lamp/).click();
  await expect(page.getByText(AURORA_DESCRIPTION)).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('2');

  await page.getByRole('button', { name: 'Next key →' }).click();
  await expect(page.getByText('Loading product a2…')).toBeVisible();
  await expect(page.getByText(AURORA_DESCRIPTION)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Cedar Desk' })).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('3');

  await page.getByRole('button', { name: '← Previous key' }).click();
  await expect(page.getByText(AURORA_DESCRIPTION)).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('3');
});

test('shows an error, then recovers on retry', async ({ page }) => {
  await openCatalog(page);

  await page.getByRole('button', { name: 'Fail next load' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Request failed');
  await expect(alert).toContainText('Simulated 500');
  await expect(page.getByTestId('product-list')).toHaveCount(0);
  await expect(page.getByTestId('stat-requests')).toHaveText('2');

  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('product-list')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('stat-requests')).toHaveText('3');
});

test('switches account without rendering old-scope data', async ({ page }) => {
  await openCatalog(page);
  await expect(page.getByTestId('stat-scope')).toHaveText('s1');

  await page.getByRole('button', { name: 'bob', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Cached data for alice was discarded');
  await expect(page.getByText('Aurora Lamp')).toHaveCount(0);
  await expect(page.getByText('Alpine Backpack')).toHaveCount(0);
  await expect(page.getByTestId('stat-scope')).toHaveText('s2');
  await expect(page.getByTestId('stat-requests')).toHaveText('1');

  await page.getByRole('button', { name: 'Load data for this account' }).click();
  await page.mouse.move(0, 0);
  await expect(product(page, /Alpine Backpack/)).toBeVisible();
  await expect(page.getByText('Aurora Lamp')).toHaveCount(0);
  await expect(page.getByTestId('stat-requests')).toHaveText('2');
  await expect(page.getByTestId('stat-scope')).toHaveText('s2');

  await page.getByRole('button', { name: 'alice', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Cached data for bob was discarded');
  await expect(page.getByText('Alpine Backpack')).toHaveCount(0);
  await expect(page.getByTestId('stat-scope')).toHaveText('s3');
  await expect(page.getByTestId('stat-requests')).toHaveText('2');

  await page.getByRole('button', { name: 'Load data for this account' }).click();
  await page.mouse.move(0, 0);
  await expect(product(page, /Aurora Lamp/)).toBeVisible();
  await expect(page.getByTestId('stat-requests')).toHaveText('3');
});
