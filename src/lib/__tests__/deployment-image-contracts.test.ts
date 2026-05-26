import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("deployment image contracts", () => {
  it("lets production Compose use prebuilt app and migration images", () => {
    const compose = readRepoFile("docker-compose.yml");

    expect(compose).toContain(
      "image: ${APP_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-app:local}",
    );
    expect(compose).toContain(
      "image: ${MIGRATE_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-migrate:local}",
    );
    expect(compose).toContain("target: builder");
  });

  it("publishes app and migration images to GHCR after CI passes", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("publish-ghcr-images:");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain(
      "APP_IMAGE: ${{ vars.GHCR_APP_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-app', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain(
      "MIGRATE_IMAGE: ${{ vars.GHCR_MIGRATE_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-migrate', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain("uses: docker/build-push-action@v7");
    expect(workflow).toContain("target: builder");
  });

  it("deploys the resolved commit SHA image references from the production script", () => {
    const deployScript = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deployScript).toContain(
      'GHCR_APP_IMAGE_REPOSITORY="${GHCR_APP_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-app}"',
    );
    expect(deployScript).toContain(
      'GHCR_MIGRATE_IMAGE_REPOSITORY="${GHCR_MIGRATE_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-migrate}"',
    );
    expect(deployScript).toContain(
      'APP_IMAGE="${GHCR_APP_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain(
      'MIGRATE_IMAGE="${GHCR_MIGRATE_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain('APP_IMAGE="$APP_IMAGE"');
    expect(deployScript).toContain('MIGRATE_IMAGE="$MIGRATE_IMAGE"');
    expect(deployScript).toContain("--internal-blue-green-deploy");
  });

  it("pulls supplied app and migration images instead of building locally", () => {
    const deploy = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deploy).toContain('APP_IMAGE="${APP_IMAGE:-}"');
    expect(deploy).toContain('MIGRATE_IMAGE="${MIGRATE_IMAGE:-}"');
    expect(deploy).toContain("validate_image_reference_contract");
    expect(deploy).toContain(
      'docker compose pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
    expect(deploy).toContain(
      'docker compose build --pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
  });

  it("copies standalone static assets without nesting static/static", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/standalone ./",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/static/ ./.next/static/",
    );
    expect(dockerfile).not.toMatch(
      /^COPY --from=builder \/app\/\.next\/static \.\/\.next\/static$/m,
    );
  });
});
