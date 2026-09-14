import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/d/jira-hierarchy-dev/jira-hierarchy-development?kiosk');
  await expect(page.getByRole('region', { name: 'Jira hierarchy timeline', exact: true })).toBeVisible();
  await expect(page.getByTestId('issue-count')).toContainText('62 tickets');
});

test('loads real VictoriaLogs results, expands parents and shows observed end details', async ({ page }) => {
  await expect(page.getByRole('treegrid')).toHaveAttribute('aria-rowcount', '44');
  await page.getByRole('region', { name: 'Jira hierarchy timeline', exact: true }).screenshot({ path: 'test-results/hierarchy-dark.png' });
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.getByTestId('jira-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.getByRole('treegrid')).toHaveAttribute('aria-rowcount', '62');
  await page.getByRole('button', { name: 'Details for PM-100', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Ticket details PM-100' });
  await expect(details).toContainText('Observed end');
  await expect(details.getByRole('link', { name: 'Open in Jira' })).toHaveAttribute('href', 'https://jira.example.invalid/browse/PM-100');
  await page.getByRole('button', { name: 'Close ticket details' }).click();
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('Demo reopened issue');
  await expect(page.getByTestId('issue-count')).toContainText('1 tickets / 2 rows');
  await page.getByRole('button', { name: 'Details for OPS-900003', exact: true }).click();
  await expect(page.getByRole('complementary')).toContainText('Reopened');
  await expect(page.getByRole('complementary')).toContainText('Observed end');
  await page.getByRole('button', { name: 'Focus subtree', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Parent ticket', exact: true })).toHaveValue('OPS-900003');
  await expect(page.getByTestId('jira-row')).toHaveCount(1);
  await expect(page.getByText('Source: jira-exporter / demo / development', { exact: true })).toBeVisible();
});

test('virtualizes thousands of rows, scrolls to the end, and keeps matching ancestors', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Parent ticket', exact: true }).fill('PM-300');
  await expect(page.getByTestId('issue-count')).toContainText('3,757 tickets');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.getByRole('treegrid')).toHaveAttribute('aria-rowcount', '3757');
  expect(await page.getByTestId('jira-row').count()).toBeLessThan(70);
  await page.getByTestId('jira-viewport').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByTestId('jira-row').last()).toHaveAttribute('aria-rowindex', '3757');
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('Scale subtask 12.24.12');
  await expect(page.getByTestId('issue-count')).toContainText('1 tickets / 4 rows');
  await expect(page.getByTestId('jira-row')).toHaveCount(4);
  await expect(page.getByRole('treegrid')).toContainText('Scale subtask 12.24.12');
  await page.getByRole('region', { name: 'Jira hierarchy timeline', exact: true }).screenshot({ path: 'test-results/hierarchy-search.png' });
});

test('filters projects across roots without dropping ancestor context and surfaces orphan data', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Parent ticket', exact: true }).fill('');
  await expect(page.getByTestId('issue-count')).toContainText('3,832 tickets');
  await expect(page.getByRole('status')).toContainText('missing or cyclic');
  await page.getByText('Projects (all)', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'REL', exact: true }).check();
  await page.getByText('Projects (1)', { exact: true }).click();
  await expect(page.getByRole('treegrid')).toContainText('PM-100');
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('Demo child of orphan');
  await expect(page.getByTestId('issue-count')).toContainText('1 tickets / 2 rows');
  await expect(page.getByRole('treegrid')).toContainText('OPS-900001');
});

test('renders on mobile with horizontal scrolling and usable ticket details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'Search tickets' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tickets' }).fill('Demo reopened issue');
  await expect(page.getByTestId('issue-count')).toContainText('1 tickets / 2 rows');
  const viewport = page.getByTestId('jira-viewport');
  expect(await viewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.getByTestId('jira-row').filter({ hasText: 'OPS-900003' }).getByRole('button', { name: /OPS-900003.*Demo reopened issue/ }).click();
  await expect(page.getByRole('complementary')).toBeVisible();
  const box = await page.getByRole('complementary').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole('complementary').screenshot({ path: 'test-results/hierarchy-mobile.png' });
});

test('matches Grafana light theme and supports local zoom without query changes', async ({ page }) => {
  await page.goto('/d/jira-hierarchy-dev/jira-hierarchy-development?kiosk&theme=light');
  await expect(page.getByTestId('issue-count')).toContainText('62 tickets');
  let queries = 0;
  page.on('request', (request) => { if (request.url().includes('/api/ds/query')) { queries++; } });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Pan later', exact: true }).click();
  await page.getByRole('button', { name: 'Fit tickets', exact: true }).click();
  expect(queries).toBe(0);
  await page.getByRole('region', { name: 'Jira hierarchy timeline', exact: true }).screenshot({ path: 'test-results/hierarchy-light.png' });
});

test('handles an absent root and returns to the full dataset', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Parent ticket', exact: true }).fill('MISSING-123');
  await expect(page.getByText('No matching tickets', { exact: true })).toBeVisible();
  await expect(page.getByTestId('jira-row')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Parent ticket', exact: true }).fill('');
  await expect(page.getByTestId('issue-count')).toContainText('3,832 tickets');
});
