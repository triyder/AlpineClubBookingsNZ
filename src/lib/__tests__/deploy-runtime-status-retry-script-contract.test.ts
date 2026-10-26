import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "@/lib/__tests__/helpers/bash-fixture-path";
import { readRepoFile } from "@/lib/__tests__/helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "@/lib/__tests__/helpers/deploy-script";

/**
 * The in-container reads `verify_internal_health` makes, RUN rather than
 * grepped (#3965).
 *
 * Step 15 of a real deploy died with nothing printed between the step header and
 * "Blue/green deployment failed.", straight after the container reported
 * healthy; a hand check moments later passed. The likeliest cause is a
 * `docker compose exec` killed mid-read when the container restarted, which
 * exits 137 with no output. The fix retries both reads (readiness, then
 * `/api/deploy/runtime-status`) against a deadline, prints a line for every
 * failed attempt, and when it gives up prints the last status, body or exec exit
 * code and what stopping means for traffic.
 *
 * Retry behaviour is exactly what a source-text assertion cannot prove, so this
 * suite lifts `verify_internal_health` and everything it calls out of the script
 * and runs it under the script's own `set -Eeuo pipefail` and an ERR trap. The
 * trap is counted: the deploy's trap is `fail`, which writes a failure record and
 * prints the failure banner, so a failed ATTEMPT must never reach it and a
 * give-up must reach it exactly once.
 *
 * Only `docker`, `sleep` and the deadline clock are stubbed. The
 * `docker compose exec` stub runs the in-container `/bin/sh` script for real,
 * with the real `node` client, against an HTTP server in this process, so the
 * status-and-body protocol between the container and the host is exercised end
 * to end, not modelled. The only rewrite is the loopback port, `3000` in the
 * container, an ephemeral one here. The clock is a file that only `sleep` and a
 * simulated slow attempt advance, so attempt counts are deterministic.
 *
 * `test:related` cannot select this file: it reads the shell script from disk,
 * so it has no import edge to it (`docs/TESTING.md`).
 */

const SCRIPT = readRepoFile(DEPLOY_SCRIPT);
const SECRET = "test-cron-secret-not-real";
const RUN_TIMEOUT_MS = 30_000;
const READINESS = "/api/health/ready";
const RUNTIME_STATUS = "/api/deploy/runtime-status";

function functionSource(name: string): string {
  return shellFunctionSource(SCRIPT, name);
}

function assignment(name: string): string {
  const match = SCRIPT.match(new RegExp(`^${name}=.*$`, "m"));
  expect(match, `${name} must be assigned in the deploy script`).not.toBeNull();
  return match![0];
}

/** The accepted range, read from the script's one definition rather than restated here. */
function integerAssignment(name: string): number {
  const value = assignment(name).slice(name.length + 1);
  expect(value, `${name} must be a plain integer`).toMatch(/^\d+$/);
  return Number(value);
}
const TIMEOUT_MIN = integerAssignment("DEPLOY_INTERNAL_READ_TIMEOUT_MIN_SECONDS");
const TIMEOUT_MAX = integerAssignment("DEPLOY_INTERNAL_READ_TIMEOUT_MAX_SECONDS");

const LIFTED_ASSIGNMENTS = [
  "CRON_SERVICE",
  "BLUE_SERVICE",
  "GREEN_SERVICE",
  "READINESS_PATH",
  "DEPLOY_RUNTIME_STATUS_PATH",
  "EXPECTED_ENVIRONMENT_ROLE_DECLARATION",
  "DEPLOY_POLL_INTERVAL_SECONDS",
  "RUNTIME_STATUS_NO_SECRET_EXIT",
  "INTERNAL_READ_REQUEST_TIMEOUT_MS",
  "DEPLOY_INTERNAL_READ_TIMEOUT_MIN_SECONDS",
  "DEPLOY_INTERNAL_READ_TIMEOUT_MAX_SECONDS",
];

const LIFTED_FUNCTIONS = [
  "get_expected_runtime_role",
  "get_expected_cron_enabled",
  "assert_readiness_payload_healthy",
  "assert_runtime_identity",
  "describe_service_container_state",
  "describe_internal_read_stop",
  "poll_service_endpoint",
  "read_service_endpoint_once",
  "get_service_readiness_payload",
  "get_service_runtime_payload",
  "verify_internal_health",
];

const fixtureDir = mkdtempSync(path.join(tmpdir(), "runtime-status-retry-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function writeHarness(runDir: string): string {
  const harness = [
    "set -Eeuo pipefail",
    `trap 'echo "ERR-TRAP-FIRED" >&2' ERR`,
    ...LIFTED_ASSIGNMENTS.map(assignment),
    `DEPLOY_INTERNAL_READ_TIMEOUT_SECONDS="$STUB_TIMEOUT"`,
    `SWITCHED_TRAFFIC="$STUB_SWITCHED_TRAFFIC"`,
    `ACTIVE_SERVICE="$STUB_ACTIVE_SERVICE"`,
    `TARGET_SERVICE="app_green"`,
    ...LIFTED_FUNCTIONS.map(functionSource),
    // The deadline clock: a file only `sleep` and a slow attempt advance.
    `deploy_clock_seconds() { cat "$STUB_DIR/clock"; }`,
    `advance_clock() { echo "$(( $(cat "$STUB_DIR/clock") + $1 ))" > "$STUB_DIR/clock"; }`,
    "sleep() { advance_clock \"$1\"; }",
    "docker() {",
    // `set -u` is on, so every positional the stub reads defaults to empty.
    '  if [ "$1 ${2:-} ${3:-} ${4:-} ${5:-}" = "compose ps -a -q app" ]; then echo "stub-container-id"; return 0; fi',
    '  if [ "$1" = "inspect" ]; then',
    '    case "$3" in',
    "      *'{{.State.Status}}'*'{{.RestartCount}}'*'{{.State.OOMKilled}}'*'{{.State.ExitCode}}'*)",
    '        [ "${4:-}" = "stub-container-id" ] && { printf \'%s\\n\' "$STUB_INSPECT"; return 0; } ;;',
    "    esac",
    '    echo "unexpected docker call: $*" >&2',
    "    return 99",
    "  fi",
    '  if [ "$1 $2 $3" != "compose exec -T" ] || [ "$5" != "/bin/sh" ] || [ "$6" != "-c" ]; then',
    '    echo "unexpected docker call: $*" >&2',
    "    return 99",
    "  fi",
    '  advance_clock "$STUB_ATTEMPT_SECONDS"',
    '  local kind=runtime fails="$STUB_RUNTIME_EXEC_FAILS" count',
    '  if [ "$9" = "/api/health/ready" ]; then kind=ready; fails="$STUB_READY_EXEC_FAILS"; fi',
    '  count="$(( $(cat "$STUB_DIR/exec-$kind" 2>/dev/null || echo 0) + 1 ))"',
    '  echo "$count" > "$STUB_DIR/exec-$kind"',
    // A `docker exec` into a container killed mid-read: 137, no output at all.
    '  if [ "$count" -le "$fails" ]; then return 137; fi',
    '  local container_script="${7//127.0.0.1:3000/127.0.0.1:$STUB_PORT}"',
    "  shift 7",
    '  CRON_SECRET="$STUB_CRON_SECRET" PATH="$STUB_NODE_DIR:$PATH" /bin/sh -c "$container_script" "$@"',
    "}",
    'if [ "$STUB_ENTRY" = "payload" ]; then',
    '  payload="$(get_service_runtime_payload app)" || exit 1',
    "  printf 'PAYLOAD=%s\\n' \"$payload\"",
    "else",
    "  verify_internal_health app",
    "  echo VERIFIED",
    "fi",
    "",
  ].join("\n");
  const harnessPath = path.join(runDir, "harness.sh");
  writeFileSync(harnessPath, harness, "utf8");
  writeFileSync(path.join(runDir, "clock"), "1000\n", "utf8");
  return harnessPath;
}

type Reply = { status: number; body: string };
type Responder = (hit: number) => Reply;

const HEALTHY_READINESS: Reply = {
  status: 200,
  body: JSON.stringify({ status: "healthy", db: { status: "ok" }, config: { status: "ok" } }),
};
const READY_BODY = JSON.stringify({
  role: "cron-leader",
  cronEnabled: true,
  environmentRole: "production",
});
const STARTING_BODY = JSON.stringify({ status: "starting", detail: "route warming" });

async function startServer(
  runtime: Responder,
  readiness: Responder = () => HEALTHY_READINESS,
) {
  const hits = { [READINESS]: 0, [RUNTIME_STATUS]: 0 };
  let readinessSawSecret = false;
  const server = http.createServer((request, response) => {
    const reply = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    };
    if (request.url === READINESS) {
      hits[READINESS] += 1;
      if (request.headers["x-cron-secret"] !== undefined) readinessSawSecret = true;
      const { status, body } = readiness(hits[READINESS]);
      reply(status, body);
      return;
    }
    if (request.url === RUNTIME_STATUS) {
      hits[RUNTIME_STATUS] += 1;
      if (request.headers["x-cron-secret"] !== SECRET) {
        reply(401, JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const { status, body } = runtime(hits[RUNTIME_STATUS]);
      reply(status, body);
      return;
    }
    reply(404, "wrong path");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    readinessHits: () => hits[READINESS],
    runtimeHits: () => hits[RUNTIME_STATUS],
    readinessSawSecret: () => readinessSawSecret,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runHarness(env: Record<string, string>) {
  const runDir = mkdtempSync(path.join(fixtureDir, "run-"));
  const harnessPath = writeHarness(runDir);
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      "bash",
      bashGateArgs(bashFixturePath(harnessPath), [], {
        STUB_DIR: bashFixturePath(runDir),
        STUB_NODE_DIR: path.dirname(process.execPath),
        STUB_CRON_SECRET: SECRET,
        STUB_TIMEOUT: "6",
        STUB_SWITCHED_TRAFFIC: "0",
        STUB_ACTIVE_SERVICE: "app_blue",
        STUB_ATTEMPT_SECONDS: "0",
        STUB_READY_EXEC_FAILS: "0",
        STUB_RUNTIME_EXEC_FAILS: "0",
        STUB_INSPECT: "running restarts=1 oom=false exit=0",
        STUB_ENTRY: "verify",
        ...env,
      }),
      { encoding: "utf8", timeout: RUN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

function trapFirings(stderr: string): number {
  return (stderr.match(/ERR-TRAP-FIRED/g) ?? []).length;
}

/** A give-up reaches the deploy's `fail` exactly once, and only after it has explained itself. */
function expectOneTrapAfter(stderr: string, explanation: string) {
  expect(trapFirings(stderr), stderr).toBe(1);
  expect(stderr.indexOf(explanation), stderr).toBeGreaterThanOrEqual(0);
  expect(stderr.indexOf("ERR-TRAP-FIRED")).toBeGreaterThan(stderr.indexOf(explanation));
}

async function withServer<T>(
  server: Awaited<ReturnType<typeof startServer>>,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    await server.close();
  }
}

describe("deploy steps 14, 15 and 17: the runtime-status read retries, then explains itself (#3965)", () => {
  it(
    "succeeds when the endpoint answers 503 a few times and then 200, saying so for each failed attempt",
    async () => {
      const server = await startServer((hit) =>
        hit <= 3 ? { status: 503, body: STARTING_BODY } : { status: 200, body: READY_BODY },
      );
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(trapFirings(result.stderr), result.stderr).toBe(0);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("VERIFIED\n");
        expect(server.runtimeHits()).toBe(4);
        for (const attempt of [1, 2, 3]) {
          expect(result.stderr).toContain(
            `Internal app: ${RUNTIME_STATUS} attempt ${attempt}: HTTP 503; asking again in 2s.`,
          );
        }
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "fails after its bound when the endpoint never stops answering 503, naming the status and the body",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("VERIFIED");
        // Timeout 6s at a 2s interval, instant attempts: attempts at 0, 2, 4 and 6 seconds.
        expect(server.runtimeHits()).toBe(4);
        const giveUp = `Internal app: ${RUNTIME_STATUS} did not answer HTTP 200 within 6s (4 attempts).`;
        expect(result.stderr).toContain(giveUp);
        expect(result.stderr).toContain("Last result: HTTP 503");
        expect(result.stderr).toContain(`Last response body: ${STARTING_BODY}`);
        expect(result.stderr).toContain(
          `set DEPLOY_INTERNAL_READ_TIMEOUT_SECONDS (${TIMEOUT_MIN}-${TIMEOUT_MAX}) in the shell that runs the deploy; it is not read from .env.`,
        );
        expectOneTrapAfter(result.stderr, giveUp);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "says the deploy stops before the cutover when traffic has not been switched",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.stderr).toContain(
          "Traffic has not been switched, so the deploy stops before the cutover. Caddy still points at app_blue,",
        );
        // Never the promise that the previous release keeps serving: after a
        // stopped-runtime deploy nothing is.
        expect(result.stderr).toContain(
          "in a windowed deploy, where the old app and workers were stopped first, nothing is serving until the deploy is re-run.",
        );
        expect(result.stderr).not.toContain("passed its health check");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "makes a single attempt at step 17, after traffic has been switched, so the rollback starts at once",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_SWITCHED_TRAFFIC: "1",
        });
        expect(result.code).not.toBe(0);
        // The configured bound (6s here) is ignored once members are on this colour.
        expect(server.runtimeHits()).toBe(1);
        const giveUp = `Internal app: ${RUNTIME_STATUS} did not answer HTTP 200 within 0s (1 attempt).`;
        expect(result.stderr).toContain(giveUp);
        expect(result.stderr).not.toContain("asking again");
        expect(result.stderr).toContain(
          "This is the check after the traffic switch: Caddy already points at app_green.",
        );
        expect(result.stderr).toContain("so the rollback starts at once.");
        expect(result.stderr).not.toContain("before the cutover");
        expect(result.stderr).not.toContain("To wait longer");
        expectOneTrapAfter(result.stderr, giveUp);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "makes a single readiness attempt at step 17 too",
    async () => {
      const server = await startServer(
        () => ({ status: 200, body: READY_BODY }),
        () => ({ status: 503, body: STARTING_BODY }),
      );
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_SWITCHED_TRAFFIC: "1",
        });
        expect(result.code).not.toBe(0);
        expect(server.readinessHits()).toBe(1);
        expect(result.stderr).toContain(
          `Internal app: ${READINESS} did not answer HTTP 200 within 0s (1 attempt).`,
        );
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "on a first blue/green deploy, says a step-17 rollback lands on the release that just failed",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        // Caddy pointed at `app`, which step 15 recreated on the new release.
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_ACTIVE_SERVICE: "app",
          STUB_SWITCHED_TRAFFIC: "1",
        });
        expect(result.code).not.toBe(0);
        const stop =
          "On this first blue/green deploy app was recreated on the new release at step 15, so the rollback lands on the release that just failed, not on the previous one.";
        expect(result.stderr).toContain(stop);
        expect(result.stderr).not.toContain("which serves only if it is still running");
        expectOneTrapAfter(result.stderr, stop);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "on a first blue/green deploy, does not call the just-recreated cron leader the previous release",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        // Caddy points at `app` itself, which step 15 has just recreated.
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_ACTIVE_SERVICE: "app",
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(
          "But Caddy points at app, and this step has just recreated app on the new release, so the previous release is not serving",
        );
        expect(result.stderr).not.toContain("Caddy still points at app");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "measures its bound on a clock, so slow attempts count against it",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        // Each attempt takes 5 simulated seconds: attempts at 0 (ends 5) and 7
        // (ends 12). Counting only the pauses would make four.
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_ATTEMPT_SECONDS: "5",
        });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(2);
        expect(result.stderr).toContain("did not answer HTTP 200 within 6s (2 attempts).");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "makes a single attempt and no retry when the bound is 0",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port), STUB_TIMEOUT: "0" });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(1);
        expect(result.stderr).toContain("within 0s (1 attempt).");
        expect(result.stderr).not.toContain("asking again");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "rides out a docker exec killed mid-read (137, no output), naming the container's state each time",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_RUNTIME_EXEC_FAILS: "2",
          STUB_ENTRY: "payload",
        });
        expect(trapFirings(result.stderr), result.stderr).toBe(0);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`PAYLOAD=${READY_BODY}\n`);
        expect(server.runtimeHits()).toBe(1);
        for (const attempt of [1, 2]) {
          expect(result.stderr).toContain(
            `Internal app: ${RUNTIME_STATUS} attempt ${attempt}: docker compose exec exited 137 with no HTTP answer; container: running restarts=1 oom=false exit=0; asking again in 2s.`,
          );
        }
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "says there was no HTTP response at all when nothing is listening",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      const closedPort = server.port;
      await server.close();

      const result = await runHarness({ STUB_PORT: String(closedPort) });
      expect(result.code).not.toBe(0);
      // Readiness is asked first, so it is the read that gives up.
      expect(result.stderr).toContain(`Internal app: ${READINESS} did not answer HTTP 200`);
      expect(result.stderr).toContain("Last result: no HTTP response (TypeError (ECONNREFUSED))");
      expectOneTrapAfter(result.stderr, "Last result: no HTTP response");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once, without retrying, when the container has no CRON_SECRET",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: "",
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("CRON_SECRET is empty inside this container");
        expect(result.stderr).toContain("set it there and re-run the deploy.");
        expect(result.stderr).not.toContain("did not answer HTTP 200");
        expect(result.stderr).not.toContain("asking again");
        expect(server.runtimeHits()).toBe(0);
        expectOneTrapAfter(result.stderr, "CRON_SECRET is empty inside this container");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once, after the traffic switch too, when the container has no CRON_SECRET",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: "",
          STUB_SWITCHED_TRAFFIC: "1",
        });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(0);
        expect(result.stderr).toContain("CRON_SECRET is empty inside this container");
        expect(result.stderr).toContain("This is the check after the traffic switch");
        expect(result.stderr).not.toContain("before the cutover");
        expectOneTrapAfter(result.stderr, "This is the check after the traffic switch");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once on HTTP 401: a wrong secret is configuration, not start-up",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: "a-different-secret",
        });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(1);
        const stop = `Internal app: ${RUNTIME_STATUS} answered HTTP 401.`;
        expect(result.stderr).toContain(stop);
        expect(result.stderr).toContain('Response body: {"error":"Unauthorized"}');
        expect(result.stderr).not.toContain("asking again");
        expectOneTrapAfter(result.stderr, stop);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once on HTTP 401 after the traffic switch too, describing the rollback",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: "a-different-secret",
          STUB_SWITCHED_TRAFFIC: "1",
        });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(1);
        expect(result.stderr).toContain(`Internal app: ${RUNTIME_STATUS} answered HTTP 401.`);
        expect(result.stderr).toContain("This is the check after the traffic switch");
        expect(result.stderr).not.toContain("before the cutover");
        expectOneTrapAfter(result.stderr, "This is the check after the traffic switch");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once on HTTP 403",
    async () => {
      const server = await startServer(() => ({ status: 403, body: "forbidden" }));
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(1);
        const stop = `Internal app: ${RUNTIME_STATUS} answered HTTP 403.`;
        expect(result.stderr).toContain(stop);
        expect(result.stderr).toContain("Response body: forbidden");
        expect(result.stderr).not.toContain("asking again");
        expectOneTrapAfter(result.stderr, stop);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once on HTTP 404: a route this image does not have",
    async () => {
      const server = await startServer(() => ({ status: 404, body: "not found" }));
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(1);
        expect(result.stderr).toContain(`Internal app: ${RUNTIME_STATUS} answered HTTP 404.`);
        expect(result.stderr).not.toContain("asking again");
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "never prints the cron secret, even when the client error would quote it",
    async () => {
      // undici rejects a header value with a newline and quotes the VALUE in its
      // message: `Headers.append: "<secret>" is an invalid header value`.
      const leakySecret = "leak-me-if-you-can\nX";
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: leakySecret,
        });
        expect(result.code).not.toBe(0);
        expect(server.runtimeHits()).toBe(0);
        expect(result.stderr).toContain("Last result: no HTTP response (TypeError)");
        expect(result.stderr).not.toContain("leak-me-if-you-can");
        expect(result.stdout).not.toContain("leak-me-if-you-can");
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("deploy steps 14, 15 and 17: the readiness read never dies silently (#3965)", () => {
  it(
    "rides out a docker exec killed mid-read on readiness too, and sends it no secret",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_READY_EXEC_FAILS: "2",
        });
        expect(trapFirings(result.stderr), result.stderr).toBe(0);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("VERIFIED\n");
        expect(server.readinessHits()).toBe(1);
        expect(server.readinessSawSecret()).toBe(false);
        for (const attempt of [1, 2]) {
          expect(result.stderr).toContain(
            `Internal app: ${READINESS} attempt ${attempt}: docker compose exec exited 137 with no HTTP answer; container: running restarts=1 oom=false exit=0;`,
          );
        }
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "gives up loudly when every readiness read is killed, with the exit code and the container's state",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      await withServer(server, async () => {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_READY_EXEC_FAILS: "99",
          STUB_INSPECT: "restarting restarts=3 oom=true exit=137",
        });
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("VERIFIED");
        const giveUp = `Internal app: ${READINESS} did not answer HTTP 200 within 6s (4 attempts).`;
        expect(result.stderr).toContain(giveUp);
        expect(result.stderr).toContain(
          "Last result: docker compose exec exited 137 with no HTTP answer; container: restarting restarts=3 oom=true exit=137",
        );
        expect(result.stderr).not.toContain("passed its health check");
        expect(server.runtimeHits()).toBe(0);
        expectOneTrapAfter(result.stderr, giveUp);
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "gives up after its bound when readiness keeps answering 503, printing the body",
    async () => {
      const unhealthy = JSON.stringify({ status: "unhealthy", db: { status: "error" } });
      const server = await startServer(
        () => ({ status: 200, body: READY_BODY }),
        () => ({ status: 503, body: unhealthy }),
      );
      await withServer(server, async () => {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.code).not.toBe(0);
        expect(server.readinessHits()).toBe(4);
        expect(result.stderr).toContain("Last result: HTTP 503");
        expect(result.stderr).toContain(`Last response body: ${unhealthy}`);
        expectOneTrapAfter(result.stderr, `Internal app: ${READINESS} did not answer HTTP 200`);
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("the retry's wiring in the deploy script (#3965)", () => {
  it("checks the retry bound at step 3, before anything is pulled or migrated", () => {
    const step3 = SCRIPT.indexOf('step "3/20"');
    const step4 = SCRIPT.indexOf('step "4/20"');
    const check = SCRIPT.indexOf(
      'require_integer_setting_in_range DEPLOY_INTERNAL_READ_TIMEOUT_SECONDS "$DEPLOY_INTERNAL_READ_TIMEOUT_SECONDS" \\\n' +
        '  "$DEPLOY_INTERNAL_READ_TIMEOUT_MIN_SECONDS" "$DEPLOY_INTERNAL_READ_TIMEOUT_MAX_SECONDS"',
    );
    expect(step3).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(step3);
    expect(check).toBeLessThan(step4);
  });

  it("measures the deadline on bash's own clock in a real deploy", () => {
    // The suite stubs `deploy_clock_seconds`; this pins what it stubs.
    expect(functionSource("deploy_clock_seconds")).toContain('"$SECONDS"');
  });
});
