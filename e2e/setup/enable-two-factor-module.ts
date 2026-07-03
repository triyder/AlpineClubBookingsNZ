// E2E bootstrap: turn on the global two-factor module (Admin > Setup >
// Modules) so the suite can exercise the Critical two-factor login journey.
// A fresh ClubModuleSettings row defaults twoFactor to false. Run by
// scripts/e2e-stack.sh after seeding, before the app starts.
import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

async function main() {
  const settings = await prisma.clubModuleSettings.upsert({
    where: { id: "default" },
    update: { twoFactor: true },
    create: { id: "default", twoFactor: true },
  });
  console.log(`Two-factor module enabled (settings id: ${settings.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
