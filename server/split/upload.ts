import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { put } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { splitBills, splitItems, splitReceiptFiles } from "../db/schema.js";
import { ApiError, forbidden, notFound, toErrorResponse } from "../errors.js";
import { respondJson } from "../router.js";
import type { Ctx } from "../router.js";
import { requireSplitUser } from "./auth.js";
import { splitDevMode, splitEnv } from "./env.js";
import { extractReceipt } from "./ocr.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Authenticated binary receipt upload. It bypasses the JSON router's small
 * body limit, stores the original privately, and sends an in-memory data URL
 * to OCR so the private blob never needs a public URL.
 */
export async function handleSplitUpload(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    }
    enforceUploadOrigin(req);
    const url = new URL(req.url ?? "/", "http://local");
    const billId = url.searchParams.get("billId");
    if (!billId || !/^[0-9a-f-]{36}$/i.test(billId)) {
      throw new ApiError(400, "invalid_bill", "Choose a valid bill.");
    }
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) {
      throw new ApiError(415, "invalid_receipt_type", "Upload a JPG, PNG, or WebP receipt.");
    }
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, "receipt_too_large", "Compress the receipt to 4 MB or less.");
    }

    const ctx = {
      req,
      res,
      method: "POST",
      pathname: url.pathname,
      params: {},
      query: url.searchParams,
      body: undefined,
      rawBody: ""
    } satisfies Ctx;
    const user = await requireSplitUser(ctx);
    const [bill] = await db.select().from(splitBills).where(and(
      eq(splitBills.id, billId),
      eq(splitBills.organizerUserId, user.id)
    )).limit(1);
    if (!bill) throw notFound();
    if (bill.status !== "review") throw forbidden("Receipts can only be replaced during review.");

    const bytes = await readUpload(req);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = safeExtension(url.searchParams.get("filename"), contentType);
    const pathname = `split/receipts/${bill.id}/${randomUUID()}${extension}`;
    const productionStorage = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    if (!productionStorage && !splitDevMode() && process.env.NODE_ENV !== "test") {
      throw new ApiError(503, "storage_unavailable", "Receipt storage is not configured.");
    }
    if (productionStorage) {
      await put(pathname, bytes, { access: "private", contentType, addRandomSuffix: false });
    }

    const [receipt] = await db.insert(splitReceiptFiles).values({
      billId: bill.id,
      blobPathname: productionStorage ? pathname : `development/${pathname}`,
      mimeType: contentType,
      sizeBytes: bytes.length,
      checksumSha256,
      status: "processing",
      retentionExpiresAt: new Date(Date.now() + 90 * 86_400_000)
    }).returning();
    if (!receipt) throw new Error("receipt_insert_failed");

    try {
      const extraction = await extractReceipt(`data:${contentType};base64,${bytes.toString("base64")}`);
      await db.transaction(async (tx) => {
        // Claim the bill version before replacing any items. If a concurrent
        // editor/upload won the race, the transaction rolls back without
        // deleting the newer draft's items.
        const updated = await tx.update(splitBills).set({
          merchantName: extraction.merchant,
          purchasedAt: extraction.purchasedAt ? new Date(extraction.purchasedAt) : null,
          currency: extraction.currency,
          subtotalCents: extraction.subtotalCents,
          taxCents: extraction.taxCents,
          tipCents: extraction.tipCents,
          feeCents: extraction.feesCents,
          discountCents: extraction.discountCents,
          totalCents: extraction.totalCents,
          version: bill.version + 1
        }).where(and(eq(splitBills.id, bill.id), eq(splitBills.version, bill.version))).returning({ id: splitBills.id });
        if (!updated.length) throw new ApiError(409, "receipt_changed", "The receipt changed while it was being scanned. Choose the latest draft and try again.");
        await tx.delete(splitItems).where(eq(splitItems.billId, bill.id));
        if (extraction.items.length) {
          await tx.insert(splitItems).values(extraction.items.map((item, index) => ({
            billId: bill.id,
            description: item.description,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents ?? Math.floor(item.lineTotalCents / item.quantity),
            lineTotalCents: item.lineTotalCents,
            displayOrder: index,
            ocrConfidenceBasisPoints: Math.round(item.confidence * 10_000)
          })));
        }
        await tx.update(splitReceiptFiles).set({
          status: "ready",
          ocrProvider: process.env.OPENCODE_GO_API_KEY ? "opencode-go" : process.env.OPENAI_API_KEY ? "openai" : "development",
          ocrModel: process.env.OPENCODE_GO_API_KEY
            ? process.env.OPENCODE_GO_RECEIPT_MODEL ?? null
            : process.env.OPENAI_RECEIPT_MODEL ?? null,
          ocrRawJson: extraction
        }).where(eq(splitReceiptFiles.id, receipt.id));
      });
      respondJson(res, 200, { receiptId: receipt.id, extraction });
    } catch (error) {
      await db.update(splitReceiptFiles).set({
        status: "failed",
        ocrErrorCode: "ocr_failed"
      }).where(eq(splitReceiptFiles.id, receipt.id));
      throw error;
    }
  } catch (error) {
    const mapped = toErrorResponse(error);
    respondJson(res, mapped.status, mapped.body);
  }
}

async function readUpload(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, "receipt_too_large", "Compress the receipt to 4 MB or less.");
    }
    chunks.push(bytes);
  }
  if (!size) throw new ApiError(400, "empty_receipt", "Choose a receipt image.");
  return Buffer.concat(chunks);
}

function safeExtension(filename: string | null, contentType: string): string {
  const requested = filename ? extname(filename).toLowerCase() : "";
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(requested)) return requested;
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return ".jpg";
}

function enforceUploadOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = new URL(splitEnv().PUBLIC_APP_ORIGIN);
  const candidates = new Set([allowed.origin]);
  if (allowed.hostname === "amitkonda.com") candidates.add(`${allowed.protocol}//www.amitkonda.com`);
  if (allowed.hostname === "www.amitkonda.com") candidates.add(`${allowed.protocol}//amitkonda.com`);
  if (!candidates.has(origin)) throw forbidden("Cross-origin requests are not allowed.");
}
