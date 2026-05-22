// =============================================================================
// Admin Access Helper
// =============================================================================
// Until we wire a proper role table, admin access is gated by a simple
// allow-list of email addresses provided via the ADMIN_EMAILS env var
// (comma-separated). This keeps the surface area minimal and reversible —
// no schema changes, no UI for granting roles, no migration to undo.
//
// To make Mitch an admin in prod, set:
//   ADMIN_EMAILS=mitch@huntlogic.ai,mitch@recademics.com
// in Vercel project settings.
//
// In dev with no env var set, the helper falls back to allowing any user
// with an email matching the configured support email — so local
// development still works.
// =============================================================================

import { auth } from "@/lib/auth";

export interface AdminCheckResult {
  ok: boolean;
  userId?: string;
  email?: string;
}

export function getAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the current session and check whether its email is in the admin
 * allow-list. Returns `ok: false` for unauthenticated or non-admin users.
 */
export async function requireAdmin(): Promise<AdminCheckResult> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  const userId = session?.user?.id;

  if (!email || !userId) {
    return { ok: false };
  }

  const allowList = getAdminEmails();

  // Dev fallback: if the allow-list is empty, accept the support-email
  // address as a safety hatch so local dev isn't locked out before the
  // env var is set.
  if (allowList.length === 0) {
    const supportEmail = (process.env.SUPPORT_EMAIL ?? "").toLowerCase();
    if (supportEmail && email === supportEmail) {
      return { ok: true, userId, email };
    }
    return { ok: false, userId, email };
  }

  return {
    ok: allowList.includes(email),
    userId,
    email,
  };
}
