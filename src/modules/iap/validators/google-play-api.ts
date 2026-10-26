// Google Play Developer API client for two calls (purchases.products.get, purchases.voidedpurchases.list), authenticated with a service account
// (OAuth 2.0 JWT bearer flow, no SDK). Grant the service account access to the app in Play Console (View financial data).

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/** purchases.products resource (fields used). */
export type ProductPurchaseState = {
  /** 0 purchased, 1 canceled, 2 pending. */
  purchaseState: number;
  /** 0 test (license tester), 1 promo, 2 rewarded; absent for normal purchases. */
  purchaseType?: number;
  orderId?: string;
  purchaseTimeMillis?: number;
  quantity?: number;
  obfuscatedExternalAccountId?: string;
};

export interface GooglePlayApi {
  /** null when Google doesn't know the token (404/410). */
  getProductPurchase(packageName: string, productId: string, token: string): Promise<ProductPurchaseState | null>;
}

/** purchases.voidedpurchases resource (fields used): a purchase Google refunded, cancelled or charged back. */
export type VoidedPurchase = {
  purchaseToken: string;
  orderId: string;
  purchaseTimeMillis: number;
  voidedTimeMillis: number;
  /** 0 user, 1 developer, 2 Google. */
  voidedSource: number;
  /** 0 other, 1 remorse, 2 not received, 3 defective, 4 accidental purchase, 5 fraud, 6 friendly fraud, 7 chargeback ... */
  voidedReason: number;
};

export type VoidedPurchasesPage = { items: VoidedPurchase[]; nextPageToken: string | null };

export interface GooglePlayVoidedApi {
  /** One page of the in-app purchases voided since `startTimeMillis` (Google only looks back 30 days). */
  listVoidedPurchases(packageName: string, startTimeMillis: number, pageToken?: string | null): Promise<VoidedPurchasesPage>;
}

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
type Fetch = typeof fetch;

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export class GooglePlayApiClient implements GooglePlayApi, GooglePlayVoidedApi {
  private accessToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly http: Fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (!account.client_email || !account.private_key) throw new Error("[iap] The Google service account file needs client_email and private_key.");
  }

  static fromFile(path: string, http?: Fetch): GooglePlayApiClient {
    return new GooglePlayApiClient(JSON.parse(readFileSync(path, "utf8")) as ServiceAccount, http);
  }

  async getProductPurchase(packageName: string, productId: string, token: string): Promise<ProductPurchaseState | null> {
    const url = `${API}/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
    const response = await this.http(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`[iap] Google Play API answered ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    return {
      purchaseState: Number(body.purchaseState ?? -1),
      purchaseType: body.purchaseType === undefined ? undefined : Number(body.purchaseType),
      orderId: typeof body.orderId === "string" ? body.orderId : undefined,
      purchaseTimeMillis: body.purchaseTimeMillis === undefined ? undefined : Number(body.purchaseTimeMillis),
      quantity: body.quantity === undefined ? undefined : Number(body.quantity),
      obfuscatedExternalAccountId: typeof body.obfuscatedExternalAccountId === "string" ? body.obfuscatedExternalAccountId : undefined,
    };
  }

  async listVoidedPurchases(packageName: string, startTimeMillis: number, pageToken?: string | null): Promise<VoidedPurchasesPage> {
    const query = new URLSearchParams({ startTime: String(Math.max(0, Math.floor(startTimeMillis))), maxResults: "100", type: "0" });
    if (pageToken) query.set("token", pageToken);
    const response = await this.http(`${API}/${encodeURIComponent(packageName)}/purchases/voidedpurchases?${query.toString()}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!response.ok) throw new Error(`[iap] Google Play voided purchases answered ${response.status}`);
    const body = (await response.json()) as { voidedPurchases?: Array<Record<string, unknown>>; tokenPagination?: { nextPageToken?: string } };
    const items: VoidedPurchase[] = [];
    for (const entry of body.voidedPurchases ?? []) {
      if (typeof entry.purchaseToken !== "string" || entry.purchaseToken.length === 0) continue;
      items.push({
        purchaseToken: entry.purchaseToken,
        orderId: typeof entry.orderId === "string" ? entry.orderId : "",
        purchaseTimeMillis: Number(entry.purchaseTimeMillis ?? 0),
        voidedTimeMillis: Number(entry.voidedTimeMillis ?? 0),
        voidedSource: Number(entry.voidedSource ?? 0),
        voidedReason: Number(entry.voidedReason ?? 0),
      });
    }
    return { items, nextPageToken: body.tokenPagination?.nextPageToken ?? null };
  }

  /** OAuth access token, cached until a minute before it expires. */
  private async token(): Promise<string> {
    const now = this.nowMs();
    if (this.accessToken && this.accessToken.expiresAtMs - 60_000 > now) return this.accessToken.value;
    const tokenUri = this.account.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(now / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.account.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.account.private_key).toString("base64url");
    const response = await this.http(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!response.ok) throw new Error(`[iap] Google OAuth answered ${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("[iap] Google OAuth answered without access_token");
    this.accessToken = { value: body.access_token, expiresAtMs: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
