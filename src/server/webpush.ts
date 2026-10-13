// Web Push without a dependency: VAPID (RFC 8292, an ES256 JWT) and the aes128gcm payload encryption (RFC 8291),
// on node:crypto. The browser's push service (FCM, Mozilla, Apple) gets the encrypted body and wakes the board's
// service worker (web/public/sw.js), which shows the notification.
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** The board's VAPID key pair: P-256, public key uncompressed (65 bytes), private scalar (32 bytes), base64url. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** What a browser's PushSubscription.toJSON() gives: where to send and the keys to encrypt for. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Fixed sender key and salt, for the RFC 8291 test vector only. */
export interface EncryptFixture {
  senderPrivateKey: string;
  salt: string;
}

const RECORD_SIZE = 4096;

/** RFC 8291 aes128gcm body: salt, record size, sender public key, then one record (payload, 0x02 padding delimiter). */
export function encryptPayload(payload: Uint8Array, keys: PushTarget["keys"], fixture?: EncryptFixture): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("invalid push keys");
  const ecdh = createECDH("prime256v1");
  if (fixture) ecdh.setPrivateKey(fromB64url(fixture.senderPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixture ? fromB64url(fixture.salt) : randomBytes(16);
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The receiving side of encryptPayload (what the browser does); for tests. */
export function decryptPayload(body: Uint8Array, uaPrivateKey: string, authSecret: string): Buffer {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16);
  const idlen = b.readUInt8(20);
  const asPublic = b.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(fromB64url(uaPrivateKey));
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const ikm = hkdf(fromB64url(authSecret), shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const data = b.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  const end = plain.lastIndexOf(2);
  return plain.subarray(0, end);
}

/** The private scalar as a KeyObject (JWK needs x and y next to d). */
function vapidPrivateKey(keys: VapidKeys) {
  const pub = fromB64url(keys.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** RFC 8292 JWT for one push service (aud = its origin), valid 12 hours. */
export function vapidJwt(audience: string, subject: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const input = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(input), { key: vapidPrivateKey(keys), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** Apple rejects a JWT without a real-looking contact; any https URL or mailto works. */
export const VAPID_SUBJECT = "https://github.com/leoawesome/kanban";

/** The HTTP request that delivers one encrypted message to a browser's push service. */
export function pushRequest(target: PushTarget, payload: string, keys: VapidKeys, opts: { ttl?: number; nowSec?: number } = {}): { url: string; init: RequestInit } {
  const aud = new URL(target.endpoint).origin;
  return {
    url: target.endpoint,
    init: {
      method: "POST",
      headers: {
        TTL: String(opts.ttl ?? 24 * 3600),
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: `vapid t=${vapidJwt(aud, VAPID_SUBJECT, keys, opts.nowSec)}, k=${keys.publicKey}`,
      },
      body: encryptPayload(Buffer.from(payload, "utf8"), target.keys),
    },
  };
}

/** Short stable id for a device, from its push endpoint. */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
}
