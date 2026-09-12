import { expect, test } from "playwright/test";

test.describe("Split browser smoke flows", () => {
  test("anonymous user sees phone sign-in and can preview the complete flow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await expect(page.getByRole("heading", { name: "Sign in to start splitting" })).toBeVisible();
    await expect(page.locator('input[name="phone"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Text me a code" })).toBeVisible();
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await expect(page.getByRole("heading", { name: /^(Morning|Afternoon|Evening), Alex\.$/ })).toBeVisible();
    await expect(page.getByText("Loro")).toBeVisible();
    await page.getByRole("button", { name: /Split a new bill/i }).click();
    await expect(page.getByRole("heading", { name: "Show us the receipt." })).toBeVisible();
    await expect(page.getByText(/OCR is a starting point/i)).toBeVisible();
  });

  test("preview dashboard exposes history and account navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await page.getByRole("link", { name: /Activity/i }).click();
    await expect(page.getByText("Loro")).toBeVisible();
    await page.getByRole("button", { name: /Account for Alex/i }).click();
    await expect(page.getByRole("heading", { name: "Alex" })).toBeVisible();
  });
});
