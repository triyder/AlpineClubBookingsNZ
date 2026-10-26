import type { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

type ClaimResult = { count: number };

/**
 * #4288: watch, or break, the as-read payment claims a code path makes on an
 * interactive transaction's client - every `payment.updateMany` keyed on
 * `updatedAt` there (the #3979 claim, which the inbound recount takes under the
 * Payment row lock). A spy on the module client's `payment.updateMany` cannot
 * see them. `onClaim` decides the result; any other call passes through.
 * Returns the spy: restore it when done.
 */
export function interceptTransactionPaymentClaims(
  prisma: PrismaClient,
  onClaim: (args: { where: Record<string, unknown> }, run: () => Promise<ClaimResult>) => Promise<ClaimResult>,
) {
  const original = prisma.$transaction.bind(prisma) as (arg: unknown, options?: unknown) => Promise<unknown>;
  return vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, options?: unknown) => {
    if (typeof arg !== "function") return original(arg, options);
    return original(
      (tx: object) =>
        arg(new Proxy(tx, {
          get: (target, key) => {
            const value = Reflect.get(target, key);
            if (key !== "payment") return value;
            return new Proxy(value as object, {
              get: (payment, method) => {
                const delegate = payment as { updateMany: (args: { where?: Record<string, unknown> }) => Promise<ClaimResult> };
                if (method !== "updateMany") return Reflect.get(payment, method);
                return (args: { where?: Record<string, unknown> }) =>
                  args?.where?.updatedAt !== undefined ? onClaim(args as { where: Record<string, unknown> }, () => delegate.updateMany(args)) : delegate.updateMany(args);
              },
            });
          },
        })),
      options,
    );
  }) as never);
}
