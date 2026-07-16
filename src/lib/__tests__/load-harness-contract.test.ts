import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("load harness semantics", () => {
  it("defaults contention to one real capacity-holding request per VU", () => {
    const config = read("load/lib/config.js");
    const scenario = read("load/scenarios/booking-contention.js");
    expect(config).toContain('intEnv(env, "CONTENTION_ATTEMPTS", 1)');
    expect(scenario).toContain('ageTier: "CHILD"');
    expect(scenario).toContain("memberReviewJustification:");
    expect(scenario).toContain('bookingStatus === "AWAITING_REVIEW"');
  });

  it("automatically gates final occupancy against configured capacity", () => {
    const scenario = read("load/scenarios/booking-contention.js");
    expect(scenario).toContain('capacity_invariant: ["rate==1"]');
    expect(scenario).toContain("evaluateContentionOccupancy({");
    expect(scenario).toContain("cfg.peakVus * cfg.contentionAttempts");
    expect(scenario).toContain("cfg.contentionExpectedBaseline");
  });

  it("authenticates every contention VU before one synchronized write barrier", () => {
    const config = read("load/lib/config.js");
    const scenario = read("load/scenarios/booking-contention.js");
    expect(config).toContain('"CONTENTION_AUTH_WARMUP_SECONDS",\n      60');
    expect(scenario).toContain("writeBarrierAtMs:");
    expect(scenario).toContain("cfg.contentionAuthWarmupSeconds * 1000");
    expect(scenario).toContain(
      'contention_auth_ready_before_barrier: ["rate==1"]'
    );
    const vuFlow = scenario.slice(
      scenario.indexOf("export default function bookingContention")
    );
    expect(vuFlow).toContain("if (__ITER === 0)");
    expect(vuFlow.indexOf("ensureLoggedIn(")).toBeLessThan(
      vuFlow.indexOf("sleep(waitMs / 1000)")
    );
    expect(vuFlow.indexOf("sleep(waitMs / 1000)")).toBeLessThan(
      vuFlow.indexOf('cfg.baseUrl + "/api/bookings"')
    );
    expect(config).toContain('intEnv(env, "CONTENTION_P95_MS", 5000)');
  });

  it("scopes dashboard latency separately from bootstrap login", () => {
    const scenario = read("load/scenarios/member-dashboard.js");
    const session = read("load/lib/session.js");
    expect(scenario).toContain('http_req_duration{flow:member_dashboard}');
    expect(scenario).toContain("dashboard_bootstrap_login_success");
    expect(scenario).toContain("[cfg.userEmail].concat(cfg.userPool)");
    expect(scenario).toContain("exec.vu.idInTest");
    expect(scenario).toContain("ensureLoggedIn(\n    cfg,\n    email,");
    expect(scenario).toContain("loginAttempted: false");
    expect(scenario).toContain(
      "const shouldRecordBootstrap = !vuState.loginAttempted"
    );
    expect(scenario).toContain(
      "if (shouldRecordBootstrap) bootstrapLoginSuccess.add(loggedIn)"
    );
    expect(session).toContain("if (state.loginAttempted)");
    expect(session).toContain("state.loginAttempted = true");
  });

  it("isolates fixed-window rate limits between load scenarios", () => {
    const session = read("load/lib/session.js");
    const login = read("load/scenarios/login.js");
    const dashboard = read("load/scenarios/member-dashboard.js");
    const contention = read("load/scenarios/booking-contention.js");
    expect(session).toContain("SCENARIO_IP_OFFSETS");
    expect(login).toContain("SCENARIO_IP_OFFSETS.login + __ITER");
    expect(dashboard).toContain("SCENARIO_IP_OFFSETS.memberDashboard");
    expect(contention).toContain("SCENARIO_IP_OFFSETS.bookingContention");
  });

  it("distributes cold logins over the configured account pool", () => {
    const scenario = read("load/scenarios/login.js");
    expect(scenario).toContain("[cfg.userEmail].concat(cfg.userPool)");
    expect(scenario).toContain("exec.vu.idInTest");
    expect(scenario).toContain("const ok = login(");
    expect(scenario).toContain("    email,");
  });

  it("uses one simultaneous cold login per VU as the primary profile", () => {
    const scenario = read("load/scenarios/login.js");
    const config = read("load/lib/config.js");
    expect(scenario).toContain('executor: "per-vu-iterations"');
    expect(scenario).toContain("vus: cfg.peakVus");
    expect(scenario).toContain("iterations: cfg.loginIterationsPerVu");
    expect(config).toContain('intEnv(env, "LOGIN_ITERATIONS_PER_VU", 1)');
  });
});
