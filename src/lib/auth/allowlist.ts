// =============================================================================
// Beta access allowlist
// =============================================================================
// Gates who can sign in during the private beta. Driven by the ALLOWED_EMAILS
// env var (comma-separated). Behavior:
//   - ALLOWED_EMAILS empty/unset  → app is OPEN (anyone who completes OAuth).
//   - ALLOWED_EMAILS set          → only those emails (plus ADMIN_EMAILS, so an
//                                    admin is never locked out) may sign in.
//
// Kept as a pure function so the decision is unit-testable without touching the
// auth/DB machinery.
// =============================================================================

/** Parse a comma-separated email env value into a normalized lowercase set. */
export function parseEmailList(raw?: string | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Decide whether `email` may sign in, given the raw ALLOWED_EMAILS and
 * ADMIN_EMAILS env values. An empty allowlist means the app is open to all.
 */
export function isEmailAllowed(
  email: string,
  allowedRaw?: string | null,
  adminRaw?: string | null,
): boolean {
  const allow = parseEmailList(allowedRaw);
  if (allow.size === 0) return true; // open beta — no gating configured
  const normalized = email.trim().toLowerCase();
  if (allow.has(normalized)) return true;
  return parseEmailList(adminRaw).has(normalized);
}
