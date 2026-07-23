import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  applyRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  getOperationalAnthropicApiKey: vi.fn(),
  checkAiBudget: vi.fn(),
  isAiMeteringHealthy: vi.fn(),
  recordAiUsage: vi.fn(),
  answerHelpQuestion: vi.fn(),
  buildHelpGrounding: vi.fn(),
  hasAdminPortalAccess: vi.fn(),
  hasFinanceViewerAccess: vi.fn(),
  memberFindUnique: vi.fn(),
  reportAiError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: {
    aiChatIp: { id: "ai-chat-ip" },
    aiChatMember: { id: "ai-chat-member" },
    aiChatGlobal: { id: "ai-chat-global" },
  },
  applyRateLimit: mocks.applyRateLimit,
  checkRateLimit: mocks.checkRateLimit,
  rateLimitedResponse: () =>
    new Response(JSON.stringify({ error: "rl" }), { status: 429 }),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/ai-assistant-config", () => ({
  getOperationalAnthropicApiKey: mocks.getOperationalAnthropicApiKey,
}));
vi.mock("@/lib/ai-assistant-usage", () => ({
  checkAiBudget: mocks.checkAiBudget,
  isAiMeteringHealthy: mocks.isAiMeteringHealthy,
  recordAiUsage: mocks.recordAiUsage,
}));
vi.mock("@/lib/anthropic-client", () => ({
  AI_ASSISTANT_MODEL: "claude-haiku-4-5",
  answerHelpQuestion: mocks.answerHelpQuestion,
}));
vi.mock("@/lib/help/grounding", () => ({
  buildHelpGrounding: mocks.buildHelpGrounding,
}));
vi.mock("@/lib/access-role-definitions", () => ({
  MEMBER_ACCESS_ROLE_SELECT: {},
}));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminPortalAccess: mocks.hasAdminPortalAccess,
  hasFinanceViewerAccess: mocks.hasFinanceViewerAccess,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));
vi.mock("@/lib/observability-bridge", () => ({
  reportAiError: mocks.reportAiError,
}));

import { POST } from "../route";

function makeRequest(body: unknown, raw?: string) {
  return new Request("https://club.example.com/api/help/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

const VALID_BODY = {
  pathname: "/bookings",
  surface: "member" as const,
  question: "How do I cancel a booking?",
  transcript: [] as Array<{ role: "user" | "assistant"; content: string }>,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    resetAt: Date.now() + 60000,
  });
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ aiAssistant: true });
  mocks.isAiMeteringHealthy.mockReturnValue(true);
  mocks.checkAiBudget.mockResolvedValue({
    allowed: true,
    spentCents: 0,
    budgetCents: 1000,
  });
  mocks.getOperationalAnthropicApiKey.mockResolvedValue("sk-ant-key");
  mocks.buildHelpGrounding.mockReturnValue("GROUNDING");
  mocks.hasAdminPortalAccess.mockReturnValue(true);
  mocks.hasFinanceViewerAccess.mockReturnValue(true);
  mocks.memberFindUnique.mockResolvedValue({ accessRoles: [] });
  mocks.recordAiUsage.mockResolvedValue(undefined);
  mocks.answerHelpQuestion.mockResolvedValue({
    ok: true,
    answer: "Cancel from your bookings page.",
    truncated: false,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    },
  });
});

function expectProviderUntouched() {
  expect(mocks.answerHelpQuestion).not.toHaveBeenCalled();
  expect(mocks.recordAiUsage).not.toHaveBeenCalled();
}

describe("POST /api/help/chat — gate order (each early exit leaves the provider untouched)", () => {
  it("1. returns the session guard's response and never spends", async () => {
    mocks.requireActiveSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expectProviderUntouched();
  });

  it("2. per-IP limit returns 429 BEFORE parsing the body (unparseable body still 429s)", async () => {
    mocks.applyRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "ip" }), { status: 429 }),
    );
    const res = await POST(makeRequest(undefined, "{ not json"));
    expect(res.status).toBe(429);
    expectProviderUntouched();
  });

  it("3. per-member limit returns 429", async () => {
    mocks.checkRateLimit.mockImplementation((config: { id: string }) =>
      Promise.resolve({
        success: config.id !== "ai-chat-member",
        limit: 10,
        remaining: 0,
        resetAt: Date.now() + 60000,
      }),
    );
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expectProviderUntouched();
  });

  it("4. returns 400 on a 9-turn transcript", async () => {
    const transcript = Array.from({ length: 9 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`,
    }));
    const res = await POST(makeRequest({ ...VALID_BODY, transcript }));
    expect(res.status).toBe(400);
    expectProviderUntouched();
  });

  it("4b. returns 400 on an over-long question", async () => {
    const res = await POST(
      makeRequest({ ...VALID_BODY, question: "x".repeat(1001) }),
    );
    expect(res.status).toBe(400);
    expectProviderUntouched();
  });

  it("4c. returns 400 on a non-slash pathname", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, pathname: "bookings" }));
    expect(res.status).toBe(400);
    expectProviderUntouched();
  });

  it("5. module off → fallback module_off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ aiAssistant: false });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "fallback", reason: "module_off" });
    expectProviderUntouched();
  });

  it("6. global limiter exhausted → fallback unavailable (not a 429)", async () => {
    mocks.checkRateLimit.mockImplementation((config: { id: string }) =>
      Promise.resolve({
        success: config.id !== "ai-chat-global",
        limit: 300,
        remaining: 0,
        resetAt: Date.now() + 60000,
      }),
    );
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "fallback", reason: "unavailable" });
    expectProviderUntouched();
  });

  it("7. metering unhealthy → fallback unavailable", async () => {
    mocks.isAiMeteringHealthy.mockReturnValue(false);
    const res = await POST(makeRequest(VALID_BODY));
    expect(await res.json()).toEqual({ status: "fallback", reason: "unavailable" });
    expectProviderUntouched();
  });

  it("8. budget denied → fallback budget_exhausted", async () => {
    mocks.checkAiBudget.mockResolvedValue({
      allowed: false,
      spentCents: 1000,
      budgetCents: 1000,
    });
    const res = await POST(makeRequest(VALID_BODY));
    expect(await res.json()).toEqual({
      status: "fallback",
      reason: "budget_exhausted",
    });
    expectProviderUntouched();
  });

  it("9. missing key → fallback not_configured", async () => {
    mocks.getOperationalAnthropicApiKey.mockResolvedValue(undefined);
    const res = await POST(makeRequest(VALID_BODY));
    expect(await res.json()).toEqual({
      status: "fallback",
      reason: "not_configured",
    });
    expectProviderUntouched();
  });
});

describe("POST /api/help/chat — surface downgrade + happy path", () => {
  it("downgrades a claimed admin surface to member when the DB member lacks admin access", async () => {
    mocks.hasAdminPortalAccess.mockReturnValue(false);
    await POST(makeRequest({ ...VALID_BODY, surface: "admin" }));
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
    // grounding is built for the downgraded (member) surface, not the claim.
    expect(mocks.buildHelpGrounding).toHaveBeenCalledWith("member", "/bookings");
  });

  it("keeps a claimed admin surface when the DB member actually has admin access", async () => {
    mocks.hasAdminPortalAccess.mockReturnValue(true);
    await POST(makeRequest({ ...VALID_BODY, surface: "admin" }));
    expect(mocks.buildHelpGrounding).toHaveBeenCalledWith("admin", "/bookings");
  });

  it("answers and records usage with questionChars = question.length", async () => {
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("answered");
    expect(json.answer).toBe("Cancel from your bookings page.");
    expect(json.remainingExchanges).toBe(4); // (8 - 0) / 2
    expect(mocks.recordAiUsage).toHaveBeenCalledTimes(1);
    const usageArg = mocks.recordAiUsage.mock.calls[0][0];
    expect(usageArg.success).toBe(true);
    expect(usageArg.questionChars).toBe(VALID_BODY.question.length);
    expect(usageArg.model).toBe("claude-haiku-4-5");
    expect(usageArg.surface).toBe("member");
  });

  it("computes remainingExchanges 0 on the 5th (8-turn) exchange", async () => {
    const transcript = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `t${i}`,
    }));
    const res = await POST(makeRequest({ ...VALID_BODY, transcript }));
    const json = await res.json();
    expect(json.remainingExchanges).toBe(0);
  });

  it("maps any provider error to a generic unavailable fallback and still records usage", async () => {
    mocks.answerHelpQuestion.mockResolvedValue({ ok: false, code: "overloaded" });
    const res = await POST(makeRequest(VALID_BODY));
    expect(await res.json()).toEqual({ status: "fallback", reason: "unavailable" });
    // both outcomes are metered
    expect(mocks.recordAiUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordAiUsage.mock.calls[0][0].success).toBe(false);
    expect(mocks.recordAiUsage.mock.calls[0][0].errorCode).toBe("overloaded");
  });

  it("additionally bridges an auth error to Sentry", async () => {
    mocks.answerHelpQuestion.mockResolvedValue({ ok: false, code: "auth" });
    await POST(makeRequest(VALID_BODY));
    expect(mocks.reportAiError).toHaveBeenCalledTimes(1);
  });

  it("meters a refusal with its usage (input billed)", async () => {
    mocks.answerHelpQuestion.mockResolvedValue({
      ok: false,
      code: "refusal",
      usage: { inputTokens: 50, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    });
    await POST(makeRequest(VALID_BODY));
    const usageArg = mocks.recordAiUsage.mock.calls[0][0];
    expect(usageArg.usage).toEqual({
      inputTokens: 50,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
