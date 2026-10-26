import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4412: the demo seed reads the club format through `getClubFormat()`, which
 * uses the application's own client (`src/lib/prisma`). That client's pool
 * keeps an idle connection for five minutes, so a seed that disconnected only
 * its own client stayed alive five minutes after its last line, and every E2E
 * job waited for it (measured: 302 s to exit before, 3 s after). The seed must
 * close the application client too.
 */
const REPO = path.resolve(__dirname, "..", "..", "..");
const seed = readFileSync(path.join(REPO, "prisma/demo-seed.ts"), "utf8");

describe("the demo seed closes every database client it opened (#4412)", () => {
  it("imports the application client and disconnects it with its own at exit", () => {
    expect(seed).toMatch(/import \{ prisma as applicationPrisma \} from "\.\.\/src\/lib\/prisma";/);
    const exit = seed.slice(seed.lastIndexOf("main()"));
    expect(exit).toMatch(/\.finally\(async \(\) => \{[\s\S]*applicationPrisma\.\$disconnect\(\)/);
    expect(exit).toMatch(/\bprisma\.\$disconnect\(\)/);
  });

  it("still reaches the application client, so the disconnect is not dead code", () => {
    // If the seed stops reading through `src/lib/prisma`, drop the import and
    // this test together rather than keep a disconnect for a client never used.
    // The real call, not the comments that name it.
    expect(seed).toMatch(/=\s*await getClubFormat\(\)/);
  });
});
