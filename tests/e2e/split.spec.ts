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

  test("blocks duplicate diner contacts while adding them", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await page.getByRole("button", { name: /Split a new bill/i }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: Buffer.from("png") });
    await expect(page.getByRole("heading", { name: "Check the details." })).toBeVisible();
    await page.locator("#person-name").fill("Maya");
    await page.locator("#person-phone").fill("(214) 555-0101");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.locator("#person-name").fill("Maya again");
    await page.locator("#person-phone").fill("+1 214-555-0101");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("That person is already on this split.")).toBeVisible();
    await expect(page.locator("#participant-list .person")).toHaveCount(1);
  });

  test("runs a real receipt upload through the review editor", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.locator('input[name="phone"]').fill("214-940-0588");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await page.locator('input[name="name"]').fill("OCR Tester");
    await page.locator('input[name="code"]').fill("000000");
    await expect(page.getByRole("heading", { name: /^(Morning|Afternoon|Evening), OCR\.$/ })).toBeVisible();
    await page.getByRole("button", { name: "Scan a receipt" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from("png")
    });
    await expect(page.getByRole("heading", { name: "Check the details." })).toBeVisible();
    await expect(page.locator('input[name="merchant"]')).toHaveValue("Demo Restaurant");
    await expect(page.locator('input[name="tax"]')).toHaveValue("2.40");
    await expect(page.locator('input[name="tip"]')).toHaveValue("6.00");
    await expect(page.locator("#calculated-total")).toHaveText("$38.40");
  });

  test("previews the diner claim flow with select-all and an immediate update state", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/split");
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await page.getByRole("link", { name: /Loro/i }).click();
    await expect(page.getByRole("button", { name: "Select all" })).toBeVisible();
    await page.getByRole("button", { name: "Select all" }).click();
    await expect(page.getByRole("button", { name: "All selected" })).toBeDisabled();
    await page.getByRole("button", { name: "Save my items" }).click();
    await expect(page.getByRole("heading", { name: "Items submitted" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update my items" })).toBeVisible();
  });

  test("previews a settled diner share with the tax and tip breakdown", async ({ page }) => {
    await page.goto("/split");
    await page.getByRole("button", { name: /Preview with sample data/i }).click();
    await page.getByRole("link", { name: /Home Slice/i }).click();
    await expect(page.getByRole("heading", { name: "Your share" })).toBeVisible();
    await expect(page.getByText("Your tax")).toBeVisible();
    await expect(page.getByText("Your tip")).toBeVisible();
    await expect(page.getByText("You’re all settled up.")).toBeVisible();
  });
});
