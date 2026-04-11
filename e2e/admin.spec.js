import { test, expect } from '@playwright/test';
import { ACTION_TIMEOUT_MS } from './test-utils.js';

test.describe('Admin dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin');
  });

  test('shows login form', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('Admin Dashboard');
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('password field has aria-label', async ({ page }) => {
    await expect(page.locator('input[type="password"]')).toHaveAttribute('aria-label', 'Password');
  });

  test('shows error for wrong password', async ({ page }) => {
    await page.fill('input[type="password"]', 'wrong-password');
    await page.click('button[type="submit"]');
    const err = page.locator('.admin-error');
    await expect(err).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    // Under `vite preview` there's no Netlify Function to hit, so the exact
    // message varies: a real 401 → "Invalid password"; a 404/network fail →
    // "Server error 404" or a fetch error. Accept any of those but still
    // fail if the error node is rendered empty.
    await expect(err).toHaveText(/invalid password|server error|failed|fetch/i);
  });
});
