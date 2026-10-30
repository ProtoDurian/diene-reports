export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ALLOWED_OWNER_IDS: string;
  OIDC_AUDIENCE: string;
  PUBLIC_BASE_URL: string;
  /** GitHub App client id (var) */
  GITHUB_CLIENT_ID: string;
  /** secrets: `wrangler secret put` */
  GITHUB_CLIENT_SECRET: string;
  SESSION_KEY: string;
  /** GitHub App id (var). With the key below, visibility checks run as the App's installation. */
  GITHUB_APP_ID: string;
  /** secret: base64 of the PEM private key GitHub lets you download for the App (PKCS#1 or PKCS#8) */
  GITHUB_APP_PRIVATE_KEY_B64: string;
}

export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;

export const LIMITS = {
  startBody: 64 * 1024,
  finishBody: 2 * 1024 * 1024,
  report: 20 * 1024 * 1024,
  raw: 20 * 1024 * 1024,
  covChunk: 4 * 1024 * 1024,
  sourceGzip: 2 * 1024 * 1024,
  sourceBytes: 1024 * 1024,
  sourceCheck: 20_000,
  failures: 200,
  recovered: 5000,
  covFiles: 20_000,
  writesPerJob: 2000,
  message: 4 * 1024,
  stack: 16 * 1024,
} as const;

export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
