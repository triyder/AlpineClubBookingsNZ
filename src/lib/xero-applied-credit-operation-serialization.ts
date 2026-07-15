/**
 * A claimed applied-credit worker found another claimed operation for the same
 * Payment. The outbox treats this as transient contention and returns this
 * operation to PENDING instead of creating a durable FAILED dead-end.
 */
export class XeroAppliedCreditOperationBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroAppliedCreditOperationBusyError";
  }
}

export function isXeroAppliedCreditOperationBusyError(
  error: unknown
): error is XeroAppliedCreditOperationBusyError {
  return error instanceof XeroAppliedCreditOperationBusyError;
}
