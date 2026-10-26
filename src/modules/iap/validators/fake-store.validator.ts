// Unity's fake store (purchases made in the Editor) and the test purchases of IAP_TEST_MODE (the client sends a receipt
// with the same envelope, without any store). Its receipts are not signed, so it is only registered when
// IAP_ALLOW_FAKE_STORE (development; refused in production by env.ts) or IAP_TEST_MODE (demo / QA servers) is on.

import { invalidReceipt, parseUnifiedReceipt, type ReceiptInput, type ReceiptValidator, type VerifiedPurchase } from "./receipt.js";

export class FakeStoreValidator implements ReceiptValidator {
  readonly store = "fake" as const;

  constructor(private readonly nowMs: () => number = Date.now) {}

  async verify(input: ReceiptInput): Promise<VerifiedPurchase> {
    const receipt = parseUnifiedReceipt(input.receipt);
    if (receipt.store !== "fake") throw invalidReceipt("not a fake store receipt");
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(receipt.transactionId)) throw invalidReceipt("fake transaction id");
    return {
      store: "fake",
      transactionId: receipt.transactionId,
      orderId: receipt.transactionId,
      storeProductId: "",
      purchasedAtMs: this.nowMs(),
      environment: "fake",
      accountToken: null,
      quantity: 1,
    };
  }
}
