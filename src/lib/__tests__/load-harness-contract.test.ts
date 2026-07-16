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

  it("scopes dashboard latency separately from bootstrap login", () => {
    const scenario = read("load/scenarios/member-dashboard.js");
    expect(scenario).toContain('http_req_duration{flow:member_dashboard}');
    expect(scenario).toContain("dashboard_bootstrap_login_success");
    expect(scenario).toContain("[cfg.userEmail].concat(cfg.userPool)");
    expect(scenario).toContain("exec.vu.idInTest");
    expect(scenario).toContain("ensureLoggedIn(\n    cfg,\n    email,");
  });

  it("distributes cold logins over the configured account pool", () => {
    const scenario = read("load/scenarios/login.js");
    expect(scenario).toContain("[cfg.userEmail].concat(cfg.userPool)");
    expect(scenario).toContain("exec.vu.idInTest");
    expect(scenario).toContain("login(cfg, email");
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
