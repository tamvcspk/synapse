import { isValidMatchPattern } from './match-pattern';

/**
 * Global SDK (docs/design.md §9): pure, environment-agnostic — no chrome.*, no I/O. Shape behind
 * docs/ROADMAP.md §11.6's Secret Service: a script references one of these by `name` (its
 * `secretRef`), but never receives `value` back in any form — only `net-request-host.ts` (running
 * in the background, at the network boundary) ever reads it, and only the Dashboard's Secrets
 * panel ever writes it. There is no `id`-keyed lookup anywhere in the runtime path on purpose: a
 * script only ever knows the `name` it declared, never a storage id.
 */
export interface SecretRecord {
  id: string;
  /** What a script references as `secretRef`. Unique across every secret — a script resolves one
   * by this alone, so two secrets sharing a name would be ambiguous. */
  name: string;
  /** Plaintext at rest (docs/ROADMAP.md §11.6: "encryption at rest with the key sitting right next
   * to it is theater"). Protected by this being a UI-only, script-unreachable surface — there is no
   * `secrets.read` scope and no listing API — not by cryptography. */
  value: string;
  /** A Chrome match pattern. `net-request-host.ts` only ever injects this secret into a request
   * whose url falls under this pattern — checked independently of whatever `match` the calling
   * script's own `net.request` grant carries. */
  allowedHost: string;
  createdAt: number;
  updatedAt: number;
}

export type SecretRecordValidation =
  | { valid: true; record: SecretRecord }
  | { valid: false; reason: string };

/**
 * Hand-rolled shape check (no schema lib, matching shared/http-mock.ts's `validateMockConfig`
 * precedent). `others` is every OTHER secret currently stored (excluding the one being edited, if
 * any) — the only reason a second argument is needed here: name uniqueness can't be checked against
 * `candidate` alone.
 */
export function validateSecretRecord(candidate: unknown, others: SecretRecord[]): SecretRecordValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'secret is not an object' };
  }
  const c = candidate as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) {
    return { valid: false, reason: 'id must be a non-empty string' };
  }
  if (typeof c.name !== 'string' || c.name.trim().length === 0) {
    return { valid: false, reason: 'name must be a non-empty string' };
  }
  if (others.some((s) => s.name === c.name)) {
    return { valid: false, reason: `a secret named "${c.name}" already exists — names must be unique` };
  }
  if (typeof c.value !== 'string' || c.value.length === 0) {
    return { valid: false, reason: 'value must be a non-empty string' };
  }
  if (typeof c.allowedHost !== 'string' || !isValidMatchPattern(c.allowedHost)) {
    return { valid: false, reason: 'allowedHost must be a valid match pattern (e.g. "https://api.openai.com/*")' };
  }
  if (typeof c.createdAt !== 'number' || typeof c.updatedAt !== 'number') {
    return { valid: false, reason: 'createdAt/updatedAt must be numbers' };
  }

  return {
    valid: true,
    record: {
      id: c.id,
      name: c.name,
      value: c.value,
      allowedHost: c.allowedHost,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    },
  };
}
