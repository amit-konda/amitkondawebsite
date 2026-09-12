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
    await expect(page.getByRole("button", { name: "Scan a receipt" })).toBeVisible();
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

  test("accepts a pasted US country-code phone number", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.locator('input[name="phone"]').fill("+1 (214) 940-0587");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  });

  test("auto-submits a six-digit verification code", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.locator('input[name="phone"]').fill("214-940-0587");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await page.locator('input[name="name"]').fill("Test User");
    await page.locator('input[name="code"]').fill("000000");
    await expect(page.getByRole("heading", { name: /^(Morning|Afternoon|Evening), Test\.$/ })).toBeVisible();
  });

  test("filters diner contacts and fills a selected phone number", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await page.getByRole("button", { name: /Scan a receipt/i }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: Buffer.from("png") });
    await expect(page.getByRole("heading", { name: "Check the details." })).toBeVisible();
    await page.locator("#person-name").fill("May");
    await expect(page.getByRole("option", { name: /Maya/ })).toBeVisible();
    await page.getByRole("option", { name: /Maya/ }).click();
    await expect(page.locator("#person-phone")).toHaveValue("+12145550101");
  });
});
