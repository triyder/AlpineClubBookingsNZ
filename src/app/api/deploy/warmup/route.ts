import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { getRuntimeStatus } from "@/lib/health-check";
import { isCmsPagePathPublished } from "@/lib/page-content-html";
import {
  discoverWarmupRoutes,
  readPublicSiteOpenState,
  resolveReleaseIdentity,
} from "@/lib/deploy/warmup-discovery";
import {
  DEFAULT_WARMUP_TOLERANCE,
  evaluateWarmup,
  type WarmupTolerance,
} from "@/lib/deploy/warmup-evaluate";
import {
  buildBlockedWarmupReport,
  buildSkippedWarmupReport,
  buildWarmupReport,
  renderWarmupReportText,
  type WarmupGateReport,
} from "@/lib/deploy/warmup-report";
import { runWarmup } from "@/lib/deploy/warmup-run";

/**
 * The pre-cutover warm-up gate (#2566, owner decision Option 4).
 *
 * `scripts/run-production-blue-green-deploy.sh` calls this ON the target release,
 * after the migrations have run and the target has passed its readiness and health
 * checks, and BEFORE it touches the Caddy upstream. The response's verdict decides
 * whether the cutover happens.
 *
 * ## Why the gate lives in the application rather than in the deploy script
 *
 * Three reasons, in order of weight:
 *
 *  1. **It is the strongest possible answer to "did we warm the right colour?"**
 *     The requests are made from inside the target container to its own loopback
 *     origin, so the process that stores each page is the process that answered.
 *     Nothing routes, so nothing can route to the live colour by mistake.
 *  2. **Untrusted CMS paths never touch a shell.** The owner's request-safety rules
 *     ("do not use `eval`", "do not concatenate unquoted CMS paths into shell
 *     commands", "pass each route safely as a separate HTTP-client argument") are
 *     satisfied structurally: the paths are read from the database into memory and
 *     handed to `fetch` as data.
 *  3. **The rules are testable.** Discovery, the tiered evaluation and the report
 *     are pure modules with unit coverage, which the same logic expressed in bash
 *     would not be.
 *
 * ## GET, deliberately
 *
 * Warming is idempotent — it populates a cache and reads pages — but a POST would
 * be the more honest verb. It stays a GET because the deploy's warm-up gate still
 * asks it with the runtime image's busybox `wget` (`node:24-alpine`), which has no
 * POST support: `docker compose exec -T <service> wget -O- …`. The image's `node`
 * could POST (the deploy's readiness and runtime-status reads use its `fetch`
 * since #3965), but the request is idempotent, so the verb buys nothing. The cron
 * secret arrives in a header the container reads from its OWN environment, so it
 * never appears in a host process list.
 *
 * ## Guarded, and one at a time
 *
 * `requireCronSecret()` — the same shared, constant-time guard
 * `/api/deploy/runtime-status` uses. A second concurrent run is refused rather than
 * queued: two warm-ups at once would double the CPU spike this design exists to
 * bound, moments before cutover.
 */

export const dynamic = "force-dynamic";

/** One run at a time per process. See the module header. */
let runInFlight = false;

interface NumericParameter {
  name: string;
  min: number;
  max: number;
  fallback: number;
}

const CONCURRENCY: NumericParameter = {
  name: "concurrency",
  min: 1,
  // The owner's decision says "a small concurrency level, such as two to four".
  // Eight is the ceiling an operator can reach deliberately; the default is three.
  max: 8,
  fallback: 3,
};

const REQUEST_TIMEOUT_SECONDS: NumericParameter = {
  name: "requestTimeoutSeconds",
  min: 1,
  max: 120,
  // A cold render costs ~3.5-5 CPU-seconds and takes 1-2s uncapped, but 4-13s on a
  // CPU-starved host (DEPLOYMENT.md → "App CPU sizing"). 20s leaves room for the
  // starved case without waiting on a release that is simply not answering.
  fallback: 20,
};

const TOTAL_TIMEOUT_SECONDS: NumericParameter = {
  name: "totalTimeoutSeconds",
  min: 5,
  max: 1800,
  fallback: 240,
};

const MAX_FAILED_CMS_ROUTES: NumericParameter = {
  name: "maxFailedCmsRoutes",
  min: 0,
  max: 100,
  fallback: DEFAULT_WARMUP_TOLERANCE.maxFailedCmsRoutes,
};

const MAX_FAILED_CMS_PERCENT: NumericParameter = {
  name: "maxFailedCmsPercent",
  min: 0,
  max: 100,
  fallback: DEFAULT_WARMUP_TOLERANCE.maxFailedCmsPercent,
};

/**
 * A whole-number query parameter, or the reason it is refused.
 *
 * Refused rather than clamped: a mistyped tolerance must not silently become a
 * wider one, and the deploy script blocks the cutover on any non-200 answer.
 */
function readNumericParameter(
  request: NextRequest,
  parameter: NumericParameter,
): { value: number } | { error: string } {
  const raw = request.nextUrl.searchParams.get(parameter.name);

  if (raw === null || raw === "") {
    return { value: parameter.fallback };
  }

  if (!/^\d+$/.test(raw)) {
    return {
      error: `${parameter.name} must be a whole number (received "${raw}")`,
    };
  }

  const value = Number.parseInt(raw, 10);
  if (value < parameter.min || value > parameter.max) {
    return {
      error: `${parameter.name} must be between ${parameter.min} and ${parameter.max} (received ${value})`,
    };
  }

  return { value };
}

/** The release identifier the deploy expects, validated as a hex commit-ish. */
function readExpectedRelease(
  request: NextRequest,
): { value: string | null } | { error: string } {
  const raw = request.nextUrl.searchParams.get("expectedRelease");

  if (raw === null || raw === "") {
    return { value: null };
  }

  if (!/^[0-9a-fA-F]{7,64}$/.test(raw)) {
    return {
      error:
        "expectedRelease must be a hexadecimal commit identifier of 7 to 64 characters",
    };
  }

  return { value: raw };
}

/**
 * The production host this release should render for, from `NEXTAUTH_URL`.
 *
 * That variable is the right source rather than a convenient one: the deploy
 * script's own `.env` contract already requires it to be a valid http(s) URL AND to
 * match `DOMAIN` (`require_http_url_env_key` / `require_domain_matches_url`), so by
 * the time this code runs it has been validated against the deployment's real
 * domain.
 */
function resolvePublicHost(): { host: string } | { problem: string } {
  const raw = process.env.NEXTAUTH_URL?.trim();

  if (!raw) {
    return {
      problem:
        "NEXTAUTH_URL is not set in this container, so the warm-up cannot render pages for the production host.",
    };
  }

  try {
    return { host: new URL(raw).host };
  } catch {
    return {
      problem: `NEXTAUTH_URL ("${raw}") is not a usable URL, so the warm-up cannot render pages for the production host.`,
    };
  }
}

/**
 * One report, two representations — and, for the text form, always HTTP 200.
 *
 * The status code is deliberately format-dependent, which needs its reason stated.
 * The deploy script asks this endpoint with busybox `wget` (`node:24.17-alpine`,
 * `Dockerfile`); on a non-2xx status it aborts and writes NO body at all. So a 400 or
 * a 409 reaches the deploy script as an empty report, and the operator gets "the
 * warm-up gate could not be read" — pointing them at the container, the network and
 * the cron secret instead of at the setting they just mistyped or at the other deploy
 * already running.
 *
 * The refusal is identical either way: the text form carries `blocked`, and the script
 * gates on the verdict sentinel, not on the status. Only the operator's information
 * changes. JSON keeps the honest REST codes for tests and any future tooling, which
 * read the body regardless of status.
 */
function respond(
  report: WarmupGateReport,
  format: "json" | "text",
  status = 200,
): NextResponse {
  if (format === "text") {
    return new NextResponse(renderWarmupReportText(report), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return NextResponse.json(report, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const unauthorized = requireCronSecret(request, {
    errorMessage: "Unauthorised",
  });
  if (unauthorized) return unauthorized;

  const format =
    request.nextUrl.searchParams.get("format") === "text" ? "text" : "json";

  const parameterErrors: string[] = [];
  const numeric = (parameter: NumericParameter): number => {
    const read = readNumericParameter(request, parameter);
    if ("error" in read) {
      parameterErrors.push(read.error);
      return parameter.fallback;
    }
    return read.value;
  };

  const concurrency = numeric(CONCURRENCY);
  const requestTimeoutSeconds = numeric(REQUEST_TIMEOUT_SECONDS);
  const totalTimeoutSeconds = numeric(TOTAL_TIMEOUT_SECONDS);
  const tolerance: WarmupTolerance = {
    maxFailedCmsRoutes: numeric(MAX_FAILED_CMS_ROUTES),
    maxFailedCmsPercent: numeric(MAX_FAILED_CMS_PERCENT),
  };

  const release = readExpectedRelease(request);
  if ("error" in release) {
    parameterErrors.push(release.error);
  }
  const expectedRelease = "value" in release ? release.value : null;

  const serviceRole = getRuntimeStatus().role;
  const host = resolvePublicHost();
  const origin = `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
  const base = {
    serviceRole,
    publicHost: "host" in host ? host.host : "unknown",
    origin,
    tolerance,
  };

  if (parameterErrors.length > 0) {
    // Through the report rather than as a bare JSON error, so the reason survives the
    // deploy script's transport — see `respond`. The verdict is `blocked`, so the
    // cutover is refused exactly as it was before, and the operator now reads WHICH
    // setting was refused instead of "the gate could not be read".
    return respond(
      buildBlockedWarmupReport(
        `The warm-up parameters this deploy asked for are not usable, so nothing was warmed: ${parameterErrors.join("; ")}. Correct the DEPLOY_WARMUP_* setting and re-run.`,
        base,
      ),
      format,
      400,
    );
  }

  if ("problem" in host) {
    return respond(buildBlockedWarmupReport(host.problem, base), format);
  }

  if (runInFlight) {
    return respond(
      buildBlockedWarmupReport(
        "A warm-up run is already in progress on this container. Two at once would double the CPU cost immediately before cutover, so the second is refused.",
        base,
      ),
      format,
      409,
    );
  }

  runInFlight = true;
  try {
    const siteState = await readPublicSiteOpenState();

    if (siteState.state === "unknown") {
      return respond(
        buildBlockedWarmupReport(
          "This release could not read the club's site-style state from the database, so it cannot render a public page either.",
          base,
        ),
        format,
      );
    }

    if (siteState.state === "pre-setup") {
      // The first deploy of a new club, and the one case where blocking would be
      // wrong: while `ClubTheme.completedAt` is NULL every public address answers
      // the 503 holding screen (#2420), and the operator completes setup through
      // the deployed site. A gate that blocked here could never be got past.
      return respond(
        buildSkippedWarmupReport(
          "The club's public website is still behind the pre-setup holding screen, so there are no public pages to warm. Complete site setup and the gate runs normally on the next deploy.",
          base,
        ),
        format,
      );
    }

    const discovery = await discoverWarmupRoutes();
    const run = await runWarmup(discovery.plan.routes, {
      origin,
      hostHeader: host.host,
      concurrency,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
      totalTimeoutMs: totalTimeoutSeconds * 1000,
      isStillPublished: isCmsPagePathPublished,
    });

    const releaseIdentity = resolveReleaseIdentity(expectedRelease);
    const evaluation = evaluateWarmup({
      discoveryProblems: discovery.plan.problems,
      discoveryWarnings: discovery.plan.warnings,
      results: run.results,
      deadlineExpired: run.deadlineExpired,
      tolerance,
      releaseIdentity,
    });

    return respond(
      buildWarmupReport({
        evaluation,
        plan: discovery.plan,
        run,
        serviceRole,
        releaseIdentity,
        publicHost: host.host,
        origin,
        cmsSnapshotAt: discovery.cmsSnapshotAt,
        concurrencyLimit: concurrency,
      }),
      format,
    );
  } catch (error) {
    // Never a 500: the deploy script must be able to read a verdict, and an
    // unexpected throw is a blocked cutover with a reason rather than a stack
    // trace it has to interpret.
    return respond(
      buildBlockedWarmupReport(
        `The warm-up gate itself failed: ${error instanceof Error ? error.message : "unknown error"}. The cutover is refused because nothing was proved about this release.`,
        base,
      ),
      format,
    );
  } finally {
    runInFlight = false;
  }
}
