import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../server/errors.js";
import {
  allocateLargestRemainder,
  allocateReceiptTotals
} from "../../server/split/allocation.js";
import {
  decryptPhone,
  encryptPhone,
  maskPhone,
  normalizePhone,
  phoneHash
} from "../../server/split/phone.js";
import {
  clearSessionCookie,
  generateOpaqueToken,
  hashInviteToken,
  hashSessionToken,
  makeInviteToken,
  readCookie,
  safeEqual,
  serializeSessionCookie,
  SPLIT_INVITE_TTL_SECONDS,
  SPLIT_SESSION_COOKIE,
  SPLIT_SESSION_TTL_SECONDS,
  verifyInviteToken
} from "../../server/split/tokens.js";
import { extractReceipt, ReceiptExtractionSchema } from "../../server/split/ocr.js";

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return (error as ApiError).code;
  }
  throw new Error("Expected action to throw");
}

describe("allocateLargestRemainder", () => {
  it("reconciles every cent and gives ties to participant id order", () => {
    const allocation = allocateLargestRemainder(100, [
      { participantId: "c", weight: 1 },
      { participantId: "a", weight: 1 },
      { participantId: "b", weight: 1 }
    ]);

    expect(Object.fromEntries(allocation)).toEqual({ a: 34, b: 33, c: 33 });
    expect([...allocation.values()].reduce((sum, cents) => sum + cents, 0)).toBe(100);
  });

  it("handles zero and rejects invalid amounts, missing shares, and weights", () => {
    expect(allocateLargestRemainder(0, [])).toEqual(new Map());
    expect(errorCode(() => allocateLargestRemainder(-1, [{ participantId: "a", weight: 1 }]))).toBe("invalid_amount");
    expect(errorCode(() => allocateLargestRemainder(1, []))).toBe("missing_shares");
    expect(errorCode(() => allocateLargestRemainder(1, [{ participantId: "a", weight: 0 }]))).toBe("invalid_share");
    expect(errorCode(() => allocateLargestRemainder(1, [{ participantId: "a", weight: 1.5 }]))).toBe("invalid_share");
  });
});

describe("allocateReceiptTotals", () => {
  it("allocates each adjustment by subtotal and preserves exact totals", () => {
    const result = allocateReceiptTotals(
      [
        { participantId: "a", subtotalCents: 1000 },
        { participantId: "b", subtotalCents: 500 },
        { participantId: "c", subtotalCents: 0 }
      ],
      { taxCents: 151, tipCents: 3, feesCents: 1, discountCents: 2 }
    );

    expect(result).toEqual([
      { participantId: "a", subtotalCents: 1000, taxCents: 101, tipCents: 2, feesCents: 1, discountCents: 1, totalCents: 1103 },
      { participantId: "b", subtotalCents: 500, taxCents: 50, tipCents: 1, feesCents: 0, discountCents: 1, totalCents: 550 },
      { participantId: "c", subtotalCents: 0, taxCents: 0, tipCents: 0, feesCents: 0, discountCents: 0, totalCents: 0 }
    ]);
    expect(result.reduce((sum, row) => sum + row.totalCents, 0)).toBe(1653);
  });

  it("rejects adjustments when every subtotal is zero", () => {
    expect(errorCode(() => allocateReceiptTotals(
      [{ participantId: "a", subtotalCents: 0 }],
      { taxCents: 1, tipCents: 0, feesCents: 0, discountCents: 0 }
    ))).toBe("zero_subtotal");
    expect(allocateReceiptTotals(
      [{ participantId: "a", subtotalCents: 0 }],
      { taxCents: 0, tipCents: 0, feesCents: 0, discountCents: 0 }
    )[0]).toMatchObject({ totalCents: 0 });
  });
});

describe("phone helpers", () => {
  it("normalizes common US formats and retains explicit country codes", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(maskPhone("555.123.4567")).toBe("••• ••• 4567");
  });

  it("rejects malformed and unsupported phone values", () => {
    for (const value of ["", "123", "555-123-45678", "+", "abc"]) {
      expect(errorCode(() => normalizePhone(value)), value).toBe("invalid_phone");
    }
  });

  it("hashes formatting-independent values and encrypts/decrypts normalized numbers", () => {
    expect(phoneHash("(555) 123-4567")).toBe(phoneHash("+1 555 123 4567"));
    expect(phoneHash("+1 555 123 4567")).not.toBe(phoneHash("+1 555 765 4321"));

    const encrypted = encryptPhone("(555) 123-4567");
    expect(encrypted.split(".")).toHaveLength(4);
    expect(decryptPhone(encrypted)).toBe("+15551234567");
    const envelope = encrypted.split(".");
    envelope[2] = `${envelope[2]!.slice(0, -1)}${envelope[2]!.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptPhone(envelope.join("."))).toThrow();
    expect(() => decryptPhone("not-an-envelope")).toThrow("Invalid encrypted phone envelope");
  });
});

describe("Split token helpers", () => {
  it("generates opaque, URL-safe tokens and keyed hashes", () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashInviteToken(token)).not.toBe(hashSessionToken(token));
  });

  it("round-trips signed invite tokens and rejects tampering", () => {
    const participantId = randomUUID();
    const token = makeInviteToken(participantId);
    expect(verifyInviteToken(token)).toBe(participantId);
    expect(verifyInviteToken(`${token}x`)).toBeNull();
    expect(verifyInviteToken(`${randomUUID()}.bad`)).toBeNull();
    expect(verifyInviteToken("not-a-uuid.signature")).toBeNull();
    expect(verifyInviteToken("no-dot")).toBeNull();
  });

  it("serializes, clears, and reads the scoped session cookie", () => {
    const token = "opaque token/+";
    expect(serializeSessionCookie(token)).toContain(`${SPLIT_SESSION_COOKIE}=opaque%20token%2F%2B`);
    expect(serializeSessionCookie(token)).toContain("Path=/api/split");
    expect(serializeSessionCookie(token)).toContain(`Max-Age=${SPLIT_SESSION_TTL_SECONDS}`);
    expect(serializeSessionCookie(token, 10)).toContain("Max-Age=10");
    expect(clearSessionCookie()).toContain(`Max-Age=0`);
    expect(readCookie(`foo=bar; ${SPLIT_SESSION_COOKIE}=opaque%20token%2F%2B`, SPLIT_SESSION_COOKIE)).toBe(token);
    expect(readCookie(undefined, SPLIT_SESSION_COOKIE)).toBeNull();
    expect(readCookie("foo=bar", SPLIT_SESSION_COOKIE)).toBeNull();
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "different")).toBe(false);
    expect(SPLIT_INVITE_TTL_SECONDS).toBe(SPLIT_SESSION_TTL_SECONDS);
  });
});

describe("receipt OCR fallback", () => {
  it("returns the deterministic reviewable development receipt without a provider key", async () => {
    const receipt = await extractReceipt("data:image/png;base64,not-used-in-fallback");
    expect(ReceiptExtractionSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      merchant: "Demo Restaurant",
      currency: "USD",
      subtotalCents: 3000,
      taxCents: 240,
      tipCents: 600,
      totalCents: 3840,
      confidence: 1
    });
    expect(receipt.items).toHaveLength(2);
    expect(receipt.warnings[0]).toContain("Development fallback");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_GO_BASE_URL;
    delete process.env.OPENCODE_GO_RECEIPT_MODEL;
    process.env.SPLIT_DEV_MODE = "true";
  });

  it("sends a vision request to OpenCode Go and parses chat-completions JSON", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-opencode-key";
    process.env.OPENCODE_GO_BASE_URL = "https://opencode.example/v1";
    process.env.OPENCODE_GO_RECEIPT_MODEL = "cheap-vision";
    process.env.SPLIT_DEV_MODE = "false";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        merchant: "Cafe",
        purchasedAt: null,
        currency: "USD",
        subtotalCents: 1000,
        taxCents: 80,
        tipCents: 0,
        feesCents: 0,
        discountCents: 0,
        totalCents: 1080,
        items: [{ description: "Coffee", quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, confidence: 0.98 }],
        confidence: 0.98,
        warnings: []
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { extractReceipt: extract } = await import("../../server/split/ocr.js");
    const receipt = await extract("data:image/png;base64,receipt");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://opencode.example/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-opencode-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("cheap-vision");
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: "data:image/png;base64,receipt" }) })
    ]));
    expect(receipt.items[0]?.description).toBe("Coffee");
  });

  it("accepts JSON wrapped in a markdown fence from a vision provider", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-opencode-key";
    process.env.SPLIT_DEV_MODE = "false";
    const extraction = {
      merchant: "Cafe", purchasedAt: null, currency: "USD", subtotalCents: 1000,
      taxCents: 80, tipCents: 0, feesCents: 0, discountCents: 0, totalCents: 1080,
      items: [{ description: "Coffee", quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, confidence: 0.9 }],
      confidence: 0.9, warnings: []
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(extraction)}\n\`\`\`` } }] }),
      { status: 200 }
    )));
    vi.resetModules();
    const { extractReceipt: extract } = await import("../../server/split/ocr.js");
    await expect(extract("data:image/png;base64,receipt")).resolves.toMatchObject(extraction);
  });

  it("falls through an empty output_text and flags arithmetic discrepancies for review", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-opencode-key";
    process.env.SPLIT_DEV_MODE = "false";
    const extraction = {
      merchant: "Cafe", purchasedAt: null, currency: "USD", subtotalCents: 1100,
      taxCents: 88, tipCents: 0, feesCents: 0, discountCents: 0, totalCents: 1188,
      items: [{ description: "Coffee", quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, confidence: 0.9 }],
      confidence: 0.9, warnings: []
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: "",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(extraction) }] }]
    }), { status: 200 })));
    vi.resetModules();
    const { extractReceipt: extract } = await import("../../server/split/ocr.js");
    await expect(extract("data:image/png;base64,receipt")).resolves.toMatchObject({
      ...extraction,
      warnings: expect.arrayContaining([
        "Line items do not exactly match the scanned subtotal. Please review the items."
      ])
    });
  });

  it("maps provider connection failures to a retryable OCR error", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-opencode-key";
    process.env.SPLIT_DEV_MODE = "false";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    vi.resetModules();
    const { extractReceipt: extract } = await import("../../server/split/ocr.js");
    await expect(extract("data:image/png;base64,receipt")).rejects.toMatchObject({ status: 502, code: "ocr_failed" });
  });

  it("turns provider failures and malformed model output into safe OCR errors", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-opencode-key";
    process.env.SPLIT_DEV_MODE = "false";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: "Cafe" }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { extractReceipt: extract } = await import("../../server/split/ocr.js");

    await expect(extract("data:image/png;base64,receipt")).rejects.toMatchObject({ status: 502, code: "ocr_failed" });
    await expect(extract("data:image/png;base64,receipt")).rejects.toMatchObject({ status: 502, code: "ocr_failed" });
    await expect(extract("data:image/png;base64,receipt")).rejects.toMatchObject({ status: 502, code: "ocr_failed" });
  });
});
