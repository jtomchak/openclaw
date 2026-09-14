import { base64UrlDecode, base64UrlEncode, decodeUtf8, utf8 } from "./encoding.js";

const TOKEN_ISSUER = "openclaw-agent-relay";
export const EDGE_TOKEN_TTL_SECONDS = 45;

interface EdgeTokenClaims {
  aud: string;
  cnf: { jkt: string };
  exp: number;
  iat: number;
  iss: typeof TOKEN_ISSUER;
  jti: string;
  sub: string;
}

function signingKey(raw: string): Uint8Array {
  const key = base64UrlDecode(raw);
  if (key.byteLength < 32) throw new Error("edge signing key must contain at least 32 bytes");
  return key;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(utf8(value)).buffer));
}

function isClaims(value: unknown): value is EdgeTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const cnf = claims.cnf;
  return (
    claims.iss === TOKEN_ISSUER &&
    typeof claims.aud === "string" &&
    typeof claims.sub === "string" &&
    typeof claims.jti === "string" &&
    typeof claims.iat === "number" &&
    typeof claims.exp === "number" &&
    !!cnf &&
    typeof cnf === "object" &&
    !Array.isArray(cnf) &&
    typeof (cnf as Record<string, unknown>).jkt === "string"
  );
}

export async function issueEdgeToken(params: {
  audience: string;
  invitationId: string;
  nowMs: number;
  signingSecret: string;
  thumbprint: string;
}): Promise<string> {
  const now = Math.floor(params.nowMs / 1000);
  const claims: EdgeTokenClaims = {
    aud: params.audience,
    cnf: { jkt: params.thumbprint },
    exp: now + EDGE_TOKEN_TTL_SECONDS,
    iat: now,
    iss: TOKEN_ISSUER,
    jti: crypto.randomUUID(),
    sub: params.invitationId,
  };
  const header = base64UrlEncode(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  const body = `${header}.${payload}`;
  return `${body}.${base64UrlEncode(await hmac(signingKey(params.signingSecret), body))}`;
}

export async function verifyEdgeToken(params: {
  audience: string;
  nowMs: number;
  signingSecret: string;
  token: string;
}): Promise<EdgeTokenClaims> {
  const segments = params.token.split(".");
  if (segments.length !== 3) throw new Error("invalid edge token");
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !payloadSegment || !signatureSegment) throw new Error("invalid edge token");
  const header: unknown = JSON.parse(decodeUtf8(base64UrlDecode(headerSegment)));
  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    (header as Record<string, unknown>).alg !== "HS256" ||
    (header as Record<string, unknown>).typ !== "JWT"
  ) {
    throw new Error("invalid edge token");
  }
  const claims: unknown = JSON.parse(decodeUtf8(base64UrlDecode(payloadSegment)));
  if (!isClaims(claims)) throw new Error("invalid edge token");
  const expected = await hmac(
    signingKey(params.signingSecret),
    `${headerSegment}.${payloadSegment}`,
  );
  const signature = base64UrlDecode(signatureSegment);
  if (
    signature.byteLength !== expected.byteLength ||
    !(await crypto.subtle.verify(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(signingKey(params.signingSecret)).buffer,
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["verify"],
      ),
      Uint8Array.from(signature).buffer,
      Uint8Array.from(utf8(`${headerSegment}.${payloadSegment}`)).buffer,
    ))
  )
    throw new Error("invalid edge token");
  const now = Math.floor(params.nowMs / 1000);
  if (
    claims.aud !== params.audience ||
    claims.iat > now + 60 ||
    claims.exp <= now ||
    claims.exp - claims.iat > EDGE_TOKEN_TTL_SECONDS
  ) {
    throw new Error("expired edge token");
  }
  return claims;
}
