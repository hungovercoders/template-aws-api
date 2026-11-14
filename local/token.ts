// A signed-in caller for the local stack. AWS Emulator's JWT authorizer
// checks a token's shape, issuer and audience, as infra/ configures them; it
// does not fetch the issuer's keys, so a throwaway key signs it. On AWS the
// same authorizer verifies the signature against your identity provider.
//   node local/token.ts <subject>     print a token, e.g. for curl
import { createSign, generateKeyPairSync } from "node:crypto";

/** What local/stack.mjs gives the authorizer when it applies infra/ to the emulator. */
export const issuer = process.env.LOCAL_JWT_ISSUER ?? "https://issuer.invalid/";
export const audience = process.env.LOCAL_JWT_AUDIENCE ?? "local";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token for `subject`, valid for a day. */
export function tokenFor(subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "RS256", typ: "JWT", kid: "local" })}.${part({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + 86_400 })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

if (process.argv[1]?.endsWith("token.ts")) console.log(tokenFor(process.argv[2] ?? "local"));
