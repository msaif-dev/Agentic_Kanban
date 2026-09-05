import { expect, test, type Page } from '@playwright/test';

/**
 * These run against a real dev server with a real (file-backed) board, so each
 * test starts from a clean slate by deleting whatever the previous one left.
 */
async function clearBoard(page: Page) {
  const board = await page.request.get('/api/board').then((response) => response.json());
  for (const task of board.tasks ?? []) {
    await page.request.delete('/api/tasks/' + task.id);
  }
}

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/run', { data: { action: 'stop' } });
  await clearBoard(page);
  await page.goto('/');
});

test('plans an objective into ordered work items', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Autonomous Task Board' })).toBeVisible();

  await page.getByLabel('Objective goal').fill('Launch the customer onboarding revamp');
  await page.getByRole('button', { name: 'Plan this objective' }).click();

  // The planner produces several items, and the board shows them by lifecycle.
  const cards = page.getByTestId('task-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  expect(await cards.count()).toBeGreaterThan(1);

  // Work with no dependencies is immediately claimable; the rest waits.
  await expect(page.getByTestId('column-ready').getByTestId('task-card')).not.toHaveCount(0);
  await expect(page.getByTestId('column-blocked').getByTestId('task-card')).not.toHaveCount(0);

  // The plan and its reasoning are on the trail.
  await expect(page.getByTestId('audit-list')).toContainText('Decomposed the objective');
});

test('agents claim and complete work without anyone assigning it', async ({ page }) => {
  await page.getByLabel('Objective goal').fill('Prepare the quarterly board report');
  await page.getByRole('button', { name: 'Plan this objective' }).click();
  await expect(page.getByTestId('task-card').first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Agents running')).toBeVisible();

  // Nothing below assigns work: the agents pull it themselves.
  await expect(page.getByTestId('column-done').getByTestId('task-card').first()).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Agents stopped')).toBeVisible();

  // The trail names which agent took which item and why.
  await expect(page.getByTestId('audit-list')).toContainText('claimed');
});

test('a person can reprioritise an item and the change is recorded', async ({ page }) => {
  await page.getByLabel('Objective goal').fill('Improve search relevance');
  await page.getByRole('button', { name: 'Plan this objective' }).click();
  await expect(page.getByTestId('task-card').first()).toBeVisible({ timeout: 30_000 });

  // Open the last item, which the planner ranked lowest.
  await page.getByTestId('task-card').last().getByRole('button', { name: 'Details' }).click();
  const inspector = page.getByTestId('task-inspector');
  await expect(inspector).toBeVisible();

  await inspector
    .getByPlaceholder('Why are you changing this? Recorded on the audit trail.')
    .fill('Customer escalation - needs to go first.');
  await inspector.getByRole('button', { name: 'P1', exact: true }).click();

  await expect(page.getByTestId('audit-list')).toContainText('Customer escalation');
  await expect(page.getByTestId('audit-list')).toContainText('Priority of');
});

test('board state survives a page reload', async ({ page }) => {
  await page.getByLabel('Objective goal').fill('Migrate the billing service');
  await page.getByRole('button', { name: 'Plan this objective' }).click();
  await expect(page.getByTestId('task-card').first()).toBeVisible({ timeout: 30_000 });

  const before = await page.getByTestId('task-card').count();
  const firstTitle = await page.getByTestId('task-card').first().textContent();

  await page.reload();

  await expect(page.getByTestId('task-card')).toHaveCount(before);
  await expect(page.getByTestId('task-card').first()).toHaveText(String(firstTitle));
});

test('a person can add a work item by hand', async ({ page }) => {
  await page.getByLabel('Objective goal').fill('Refresh the pricing page');
  await page.getByRole('button', { name: 'Plan this objective' }).click();
  await expect(page.getByTestId('task-card').first()).toBeVisible({ timeout: 30_000 });

  const planned = await page.getByTestId('task-card').count();

  await page.getByLabel('New task title').fill('Check competitor pricing');
  await page.getByLabel('New task details').fill('Survey the five closest competitors.');
  await page.getByRole('button', { name: 'Add to queue' }).click();

  await expect(page.getByTestId('task-card')).toHaveCount(planned + 1);

  // Scoped to the board: the title also appears in the audit trail, which is
  // itself worth asserting - adding an item by hand is a recorded action.
  const added = page
    .getByTestId('column-ready')
    .getByTestId('task-card')
    .filter({ hasText: 'Check competitor pricing' });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText('Survey the five closest competitors.');

  await expect(page.getByTestId('audit-list')).toContainText(
    'Human operator created "Check competitor pricing"'
  );
});

test('cards are reachable and draggable from the keyboard', async ({ page }) => {
  await page.getByLabel('Objective goal').fill('Tidy the changelog');
  await page.getByRole('button', { name: 'Plan this objective' }).click();
  await expect(page.getByTestId('task-card').first()).toBeVisible({ timeout: 30_000 });

  const card = page.getByTestId('task-card').first();
  await card.focus();
  await expect(card).toBeFocused();

  // Space picks the card up; dnd-kit announces the drag to assistive tech.
  await page.keyboard.press('Space');
  await expect(page.locator('[role="status"]')).toContainText(/pick|dragg/i);
  await page.keyboard.press('Escape');
});
