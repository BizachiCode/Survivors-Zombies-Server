// Verification of the JWS Apple signs (StoreKit 2 transactions and App Store Server Notifications V2), offline like
// Apple's App Store Server Library: the x5c chain must end at a trusted root (Apple Root CA - G3 by default), each
// certificate must be signed by the next and valid at the signing date, the leaf and intermediate must carry Apple's
// receipt-signing OIDs, and the ES256 signature must match.

import { verify as verifySignature, X509Certificate } from "node:crypto";

import { APPLE_ROOT_CA_G3 } from "./apple-root-ca.js";
import { invalidReceipt } from "./receipt.js";

/** DER of the OIDs 1.2.840.113635.100.6.11.1 (receipt signing leaf) and 1.2.840.113635.100.6.2.1 (WWDR intermediate). */
const LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex");
const INTERMEDIATE_OID = Buffer.from("060a2a864886f76364060201", "hex");

/** The trusted roots as certificates; `der` defaults to Apple Root CA - G3 (tests pass their own). */
export function appleTrustedRoots(der: readonly Buffer[] = [APPLE_ROOT_CA_G3]): X509Certificate[] {
  return der.map((cert) => new X509Certificate(cert));
}

/**
 * Checks the certificate chain and the signature of `jws` and returns its payload. Throws IAP_RECEIPT_INVALID when
 * anything is wrong. `signedDate` of the payload (when present) is the moment the chain must have been valid.
 */
export function verifyAppleJws<T extends { signedDate?: number }>(jws: string, roots: readonly X509Certificate[]): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw invalidReceipt("malformed JWS");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: unknown; x5c?: unknown };
  let payload: T;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as typeof header;
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T;
  } catch {
    throw invalidReceipt("JWS is not JSON");
  }
  if (header.alg !== "ES256") throw invalidReceipt("JWS algorithm");
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === "string")) throw invalidReceipt("JWS certificates");

  let chain: X509Certificate[];
  try {
    chain = (header.x5c as string[]).map((cert) => new X509Certificate(Buffer.from(cert, "base64")));
  } catch {
    throw invalidReceipt("JWS certificate encoding");
  }
  const [leaf, intermediate, root] = chain;
  if (!roots.some((trusted) => trusted.raw.equals(root.raw))) throw invalidReceipt("untrusted root");
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw invalidReceipt("intermediate not issued by the root");
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw invalidReceipt("leaf not issued by the intermediate");
  if (!leaf.raw.includes(LEAF_OID) || !intermediate.raw.includes(INTERMEDIATE_OID)) throw invalidReceipt("not an App Store signing certificate");
  const at = payload.signedDate ?? Date.now();
  for (const cert of chain) {
    if (at < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo)) throw invalidReceipt("certificate expired at signing");
  }

  const signed = verifySignature("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(encodedSignature, "base64url"));
  if (!signed) throw invalidReceipt("bad JWS signature");
  return payload;
}
