import { expect } from '@playwright/test';

export async function showPDFControls(page, kind = 'pdf') {
  const more = page.getByTestId(`${kind}-more`);
  if (!await more.isVisible()) return;
  const menu = page.locator(`#${await more.getAttribute('aria-controls')}`);
  // Escape closes the popover before its queued toggle event updates ARIA.
  // Read the browser's current state when deciding whether to open it again.
  if (!await menu.evaluate(element => element.matches(':popover-open'))) await more.click();
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}
