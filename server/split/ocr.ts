import { z } from "zod";
import { ApiError } from "../errors.js";
import { isOpenAiConfigured, splitDevMode, splitEnv } from "./env.js";

export const ReceiptExtractionSchema = z.object({
  merchant: z.string().max(160).nullable(),
  purchasedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid date").nullable(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()).default("USD"),
  subtotalCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  tipCents: z.number().int().nonnegative(),
  feesCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  items: z.array(z.object({
    description: z.string().min(1).max(240),
    quantity: z.number().int().positive(),
    unitPriceCents: z.number().int().nonnegative().nullable(),
    lineTotalCents: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1)
  })).max(250),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string().max(240)).max(20)
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merchant", "purchasedAt", "currency", "subtotalCents", "taxCents", "tipCents", "feesCents", "discountCents", "totalCents", "items", "confidence", "warnings"],
  properties: {
    merchant: { type: ["string", "null"] },
    purchasedAt: { type: ["string", "null"], description: "ISO 8601 date/time if visible" },
    currency: { type: "string" },
    subtotalCents: { type: "integer", minimum: 0 },
    taxCents: { type: "integer", minimum: 0 },
    tipCents: { type: "integer", minimum: 0 },
    feesCents: { type: "integer", minimum: 0 },
    discountCents: { type: "integer", minimum: 0 },
    totalCents: { type: "integer", minimum: 0 },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unitPriceCents", "lineTotalCents", "confidence"],
        properties: {
          description: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
          unitPriceCents: { type: ["integer", "null"], minimum: 0 },
          lineTotalCents: { type: "integer", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } }
  }
} as const;

/** Extract a receipt from a private signed URL or data URL. OCR is always a reviewable draft. */
export async function extractReceipt(imageUrl: string): Promise<ReceiptExtraction> {
  if (!isOpenAiConfigured()) {
    if (splitDevMode() || process.env.NODE_ENV === "test") return deterministicDevReceipt();
    throw new ApiError(503, "ocr_unavailable", "Receipt scanning is temporarily unavailable.");
  }
  const e = splitEnv();
  const openCode = Boolean(e.OPENCODE_GO_API_KEY);
  const endpoint = openCode
    ? `${e.OPENCODE_GO_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://api.openai.com/v1/responses";
  const requestBody = openCode ? {
    model: e.OPENCODE_GO_RECEIPT_MODEL,
    messages: [{ role: "user", content: [
      { type: "text", text: "Extract this receipt and return only a valid JSON object with exactly these keys: merchant (string or null), purchasedAt (ISO date string or null), currency (3-letter code), subtotalCents, taxCents, tipCents, feesCents, discountCents, totalCents (integer cents), items (array of objects with description, quantity, unitPriceCents, lineTotalCents, confidence), confidence (0 to 1), and warnings (array of strings). Do not use markdown fences. Do not invent unreadable values; put a warning in warnings." },
      { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
    ] }],
    // OpenCode Go's current gateway supports json_object but not the newer
    // json_schema response format. The response is still validated strictly
    // with ReceiptExtractionSchema below before it can become a draft.
    response_format: { type: "json_object" }
  } : {
    model: e.OPENAI_RECEIPT_MODEL,
    instructions: "Extract the receipt faithfully. Monetary values must be integer cents. Do not invent unreadable items; add a warning. The output is a draft that a person will review.",
    input: [{ role: "user", content: [
      { type: "input_text", text: "Extract merchant, date, every purchased line, adjustments, and total from this receipt." },
      { type: "input_image", image_url: imageUrl, detail: "high" }
    ] }],
    text: { format: { type: "json_schema", name: "receipt", strict: true, schema: jsonSchema } }
  };
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${e.OPENCODE_GO_API_KEY ?? e.OPENAI_API_KEY!}`,
        "Content-Type": "application/json",
        ...(openCode ? { "x-opencode-session": "split-ocr" } : {})
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    // DNS failures, timeouts, and connection resets are provider failures too.
    // Keep the client-facing error stable and avoid turning a transient outage
    // into an unhelpful 500 response.
    console.error("Split OCR provider request failed", error);
    throw new ApiError(502, "ocr_failed", "The receipt could not be scanned. Try again.");
  }
  if (!response.ok) {
    console.error("Split OCR provider failure", response.status);
    throw new ApiError(502, "ocr_failed", "The receipt could not be scanned. Try again.");
  }
  let payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
  try {
    payload = await response.json() as typeof payload;
  } catch (error) {
    console.error("Split OCR provider returned invalid JSON", error);
    throw new ApiError(502, "ocr_failed", "The receipt scan returned invalid data.");
  }
  const chatContent = payload.choices?.[0]?.message?.content;
  const chatText = typeof chatContent === "string"
    ? chatContent
    : chatContent?.find((c) => c.type === "text" || Boolean(c.text))?.text;
  // Some OpenAI-compatible providers include an empty `output_text` field and
  // put the actual response in the nested output/choices shape. Prefer the
  // first non-empty candidate instead of letting an empty field mask it.
  const text = [
    payload.output_text,
    payload.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text,
    chatText
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!text) throw new ApiError(502, "ocr_failed", "The receipt could not be scanned. Try again.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new ApiError(502, "ocr_failed", "The receipt scan returned invalid data.");
  }
  try {
    const extraction = ReceiptExtractionSchema.parse(parsed);
    return addArithmeticWarnings(extraction);
  } catch {
    throw new ApiError(502, "ocr_failed", "The receipt scan returned incomplete data.");
  }
}

/**
 * Keep mathematically inconsistent OCR as a reviewable draft, but make the
 * discrepancy visible to the editor. Receipts can contain rounding, bundled
 * items, or unreadable lines, so rejecting the scan here would strand the
 * user before they can correct it.
 */
function addArithmeticWarnings(extraction: ReceiptExtraction): ReceiptExtraction {
  const itemSubtotal = extraction.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const expectedTotal = extraction.subtotalCents + extraction.taxCents + extraction.tipCents + extraction.feesCents - extraction.discountCents;
  const warnings = [...extraction.warnings];
  if (itemSubtotal !== extraction.subtotalCents) {
    warnings.push("Line items do not exactly match the scanned subtotal. Please review the items.");
  }
  if (extraction.items.some((item) => item.confidence < 0.75)) {
    warnings.push("One or more items were hard to read. Please review those lines before publishing.");
  }
  if (expectedTotal !== extraction.totalCents) {
    warnings.push("Tax, tip, discounts, and subtotal do not exactly match the scanned total. Please review the amounts.");
  }
  return warnings.length === extraction.warnings.length
    ? extraction
    : { ...extraction, warnings: warnings.slice(0, 20) };
}

/** Vision providers occasionally wrap otherwise-valid JSON in a markdown fence. */
function stripJsonFences(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function deterministicDevReceipt(): ReceiptExtraction {
  return {
    merchant: "Demo Restaurant",
    purchasedAt: "2026-01-01",
    currency: "USD",
    subtotalCents: 3000,
    taxCents: 240,
    tipCents: 600,
    feesCents: 0,
    discountCents: 0,
    totalCents: 3840,
    items: [
      { description: "Demo entree", quantity: 1, unitPriceCents: 1800, lineTotalCents: 1800, confidence: 1 },
      { description: "Demo drink", quantity: 2, unitPriceCents: 600, lineTotalCents: 1200, confidence: 1 }
    ],
    confidence: 1,
    warnings: ["Development fallback receipt; review before publishing."]
  };
}
