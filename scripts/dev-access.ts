// Local stand-in for Cloudflare Access: serves JWKS at /cdn-cgi/access/certs and proxies every other request
// to `wrangler dev`, adding a signed Cf-Access-Jwt-Assertion header.
//   wrangler dev --local --port 8799 --var ACCESS_TEAM_DOMAIN:http://localhost:8800 --var ACCESS_AUD:local-dev
//   bun scripts/dev-access.ts            # then open http://localhost:8800/
const UPSTREAM = process.env.UPSTREAM ?? "http://localhost:8799";
const PORT = Number(process.env.PORT ?? 8800);
const TEAM = `http://localhost:${PORT}`;
const AUD = process.env.ACCESS_AUD ?? "local-dev";
const KID = `dev-${Date.now()}`;

const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID, use: "sig", alg: "RS256" };
const b64 = (v: string | ArrayBuffer) => Buffer.from(typeof v === "string" ? v : new Uint8Array(v)).toString("base64url");

async function token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: TEAM, aud: [AUD], iat: now, nbf: now, exp: now + 3600, email: "dev@localhost" }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
    const headers = new Headers(req.headers);
    headers.set("cf-access-jwt-assertion", await token());
    const up = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual" });
    const out = new Headers(up.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(up.body, { status: up.status, headers: out });
  },
});
console.log(`Access stand-in on ${TEAM} -> ${UPSTREAM}`);
export {};
