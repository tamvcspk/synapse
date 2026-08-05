import { matchesUrlPattern } from '../../../shared/match-pattern';
import type { SecretRecord } from '../../../shared/secrets';

export type SecretLookup = (name: string) => Promise<SecretRecord | undefined>;

/**
 * Resolves a named secret's value for use against `requestUrl` — the one check shared by every
 * `{secretRef}` consumer (net.request's per-header value, ai.ask's own credential, docs/ROADMAP.md
 * §11.6): the secret must exist, and its own `allowedHost` (bound once at creation in the Dashboard,
 * independent of any script's grant) must match the url it's about to be used against. Factored out
 * of net-request-host.ts when ai.ask became the second caller — same check, same failure messages,
 * worth having once. Never returns anything alongside the value that could let it leak back to a
 * caller; that discipline is the caller's job (never echo it into a response or a thrown message).
 */
export async function resolveSecretForRequest(
  callerLabel: string,
  secretRef: string,
  requestUrl: string,
  secretLookup: SecretLookup,
): Promise<string> {
  const secret = await secretLookup(secretRef);
  if (!secret) throw new Error(`${callerLabel}: secret "${secretRef}" does not exist`);
  if (!matchesUrlPattern(requestUrl, secret.allowedHost)) {
    throw new Error(
      `${callerLabel}: secret "${secretRef}" is bound to "${secret.allowedHost}", which does not match this request's url`,
    );
  }
  return secret.value;
}
