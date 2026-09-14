import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldAdvanceSmsStatus } from "../../server/split/webhooks.js";

describe("Split Twilio delivery ordering", () => {
  it("never regresses a terminal delivery state", () => {
    expect(shouldAdvanceSmsStatus("sent", "delivered")).toBe(true);
    expect(shouldAdvanceSmsStatus("delivered", "failed")).toBe(false);
    expect(shouldAdvanceSmsStatus("failed", "delivered")).toBe(false);
    expect(shouldAdvanceSmsStatus("delivered", "delivered")).toBe(true);
  });
});

describe("Split Twilio product configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    delete process.env.TWILIO_MESSAGING_FROM;
    process.env.SPLIT_DEV_MODE = "true";
  });

  it("sends invitations with Messaging even when Verify is not configured", async () => {
    process.env.SPLIT_DEV_MODE = "false";
    process.env.TWILIO_ACCOUNT_SID = "AC-test";
    process.env.TWILIO_AUTH_TOKEN = "token-test";
    process.env.TWILIO_MESSAGING_FROM = "+15551234567";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: "SM-test", status: "queued" }), { status: 201 })));
    vi.resetModules();
    const { sendSms } = await import("../../server/split/sms.js");
    await expect(sendSms("+12145550101", "Split invite")).resolves.toMatchObject({ providerId: "SM-test" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("Messages.json");
  });
});
