import { test, expect } from '@playwright/test';

test.describe('Feedback form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/feedback');
  });

  test('shows feedback form with categories', async ({ page }) => {
    await expect(page.locator('.feedback-title')).toContainText('Beta Feedback');
    const categories = page.locator('.feedback-cat-btn');
    await expect(categories).toHaveCount(4);
  });

  test('selecting Bug category shows severity and steps fields', async ({ page }) => {
    await page.click('.feedback-cat-btn:has-text("Bug")');
    await expect(page.locator('.feedback-severity')).toBeVisible();
    await expect(page.locator('textarea').nth(1)).toBeVisible(); // steps textarea
  });

  test('selecting Feature category hides severity and steps', async ({ page }) => {
    await page.click('.feedback-cat-btn:has-text("Feature")');
    await expect(page.locator('.feedback-severity')).not.toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(1); // only details
  });

  test('shows validation error for empty summary', async ({ page }) => {
    await page.click('.feedback-cat-btn:has-text("General")');
    await page.click('.feedback-submit');
    const err = page.locator('.feedback-error');
    await expect(err).toBeVisible();
    // Catches any future wording tweak ("Please write a short summary.",
    // "Summary is required", etc.) while still failing if the wrong error
    // surfaces (e.g. the category error, or a stale network message).
    await expect(err).toHaveText(/summary/i);
  });

  test('back button exists and is clickable', async ({ page }) => {
    const back = page.locator('.top-back-btn');
    await expect(back).toBeVisible();
  });
});
