/**
 * Map executor status codes / messages into short copy for the mint & SA UIs.
 * Defense-in-depth for older jobs that still stored raw FdcHub strings.
 */
export function humanizeExecutorError(params: {
  code: string;
  message: string;
  retryable?: boolean;
}): string {
  const raw = `${params.code} ${params.message}`;
  if (/insufficient funds|exceeds the balance|gas required exceeds|needs more C2FLR/i.test(raw)) {
    return "The operator wallet is low on C2FLR (needed for FDC fees and gas). Fund it on the Coston2 faucet, then try again.";
  }
  if (/FdcHub|XRPPayment request|Payment request to FdcHub/i.test(raw)) {
    return "Could not submit the Flare Data Connector proof request. Usually the operator needs more C2FLR — fund the executor and retry.";
  }
  if (/NoWithdrawalAmount/i.test(raw)) {
    return "Nothing to claim for that Firelight period. Use the period id from your withdraw request after the period ends.";
  }
  if (/CallFailed/i.test(raw)) {
    return "The Smart Account vault call failed. Check the destination vault and amount, then try again.";
  }
  const message =
    params.message.length > 220
      ? `${params.message.slice(0, 219)}…`
      : params.message;
  const retry = params.retryable
    ? " The executor will retry automatically."
    : "";
  return `${message}${retry}`;
}
