// =============================================================================
// Next.js Middleware — Auth protection + onboarding redirects + stale cookie cleanup
// =============================================================================

import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// Routes that don't require authentication
const PUBLIC_ROUTES = new Set([
  "/",
  "/login",
  "/signup",
  "/verify",
  "/pricing",
  "/features",
  "/about",
  "/terms",
  "/privacy",
  "/ops/login",
]);

// Path prefixes that are always public
const PUBLIC_PREFIXES = [
  "/api/auth",
  "/api/chat",
  "/api/health",
  "/api/webhooks",
  // Admin maintenance endpoints — bypass the session-auth middleware so
  // they can be hit with a CRON_SECRET Bearer token from outside the app
  // (curl from a laptop, GitHub Actions, etc). Each route is responsible
  // for verifying the secret itself.
  "/api/admin",
  "/api/v1/deadlines",
  "/api/v1/regulations",
  "/api/v1/explore",
  "/api/v1/species",
  "/api/v1/outfitters",
  "/api/v1/tenant",
  "/api/v1/applications/",
  "/api/v1/map/",
  "/api/v1/ingestion/trigger",
  "/api/v1/ops/auth",
  // Portfolio engine endpoint handles auth internally — either pulls from
  // the signed-in user's pointHoldings OR accepts an explicit holdings array
  // in the body. Listed here so the middleware doesn't bounce body-passed
  // anonymous calls to /login.
  "/api/v1/portfolio",
  "/_next",
  "/favicon",
];

// ---------------------------------------------------------------------------
// Stale cookie cleanup: after AUTH_SECRET rotation, old session cookies
// signed with the previous secret cause JWTSessionError → infinite login loop.
// This middleware deletes legacy prefixed cookies on every request so users
// don't need to manually clear them.
// ---------------------------------------------------------------------------
// ⚠️  Only delete PREFIXED cookies — the unprefixed ones are our ACTIVE cookies!
// Our auth config uses authjs.csrf-token, authjs.session-token etc (no prefix).
// The __Host-/__Secure- prefixed versions are stale and cause login loops.
const STALE_COOKIE_NAMES = [
  // Legacy prefixed cookies (these break SSO — see incident 2026-03-15)
  "__Secure-authjs.session-token",
  "__Host-authjs.csrf-token",
  "__Secure-authjs.callback-url",
  "__Secure-authjs.pkce.code_verifier",
  // Legacy next-auth v4 names
  "__Secure-next-auth.session-token",
  "__Host-next-auth.csrf-token",
  "__Secure-next-auth.callback-url",
];

function cleanStaleCookies(
  req: Parameters<Parameters<typeof auth>[0]>[0],
  res: NextResponse
): NextResponse {
  for (const name of STALE_COOKIE_NAMES) {
    if (req.cookies.get(name)) {
      res.cookies.set(name, "", {
        expires: new Date(0),
        path: "/",
        secure: true,
        httpOnly: true,
      });
    }
  }
  return res;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  let response: NextResponse;

  // -------------------------------------------------------------------------
  // 1. Always allow public prefixes
  // -------------------------------------------------------------------------
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    response = NextResponse.next();
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 1b. Ops API routes (non-auth) — require ops_session cookie
  // -------------------------------------------------------------------------
  if (
    pathname.startsWith("/api/v1/ops") &&
    !pathname.startsWith("/api/v1/ops/auth")
  ) {
    const opsToken = req.cookies.get("ops_session")?.value;
    if (!opsToken) {
      return NextResponse.json(
        { error: "Ops authentication required" },
        { status: 401 }
      );
    }
    response = NextResponse.next();
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 1c. Ops pages (non-login) — require ops_session cookie
  // -------------------------------------------------------------------------
  if (pathname.startsWith("/ops") && pathname !== "/ops/login") {
    const opsToken = req.cookies.get("ops_session")?.value;
    if (!opsToken) {
      return NextResponse.redirect(new URL("/ops/login", req.url));
    }
    response = NextResponse.next();
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 2. Always allow static assets
  // -------------------------------------------------------------------------
  if (
    pathname.includes(".") &&
    !pathname.startsWith("/api/")
  ) {
    response = NextResponse.next();
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 3. Public routes — no auth required
  // -------------------------------------------------------------------------
  const isPublicRoute = PUBLIC_ROUTES.has(pathname);
  const isAuthenticated = !!req.auth?.user?.id;

  // -------------------------------------------------------------------------
  // 3a. Root "/" → redirect to landing site (unauthenticated) or dashboard
  // -------------------------------------------------------------------------
  const LANDING_SITE = process.env.LANDING_SITE_URL || "https://huntlogic-site.vercel.app";
  if (pathname === "/") {
    if (isAuthenticated) {
      response = NextResponse.redirect(new URL("/dashboard", req.url));
    } else {
      response = NextResponse.redirect(LANDING_SITE);
    }
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 4. Not authenticated + protected route → redirect to login
  //    Also clear the active session cookie — if we're here, it either
  //    doesn't exist or was encrypted with a stale AUTH_SECRET (JWTSessionError).
  //    Clearing it prevents an infinite loop where the browser keeps sending
  //    an undecryptable token on every request.
  // -------------------------------------------------------------------------
  if (!isAuthenticated && !isPublicRoute) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    response = NextResponse.redirect(loginUrl);
    // Force-clear the active session cookie so next login starts fresh
    response.cookies.set("authjs.session-token", "", {
      expires: new Date(0),
      path: "/",
      secure: true,
      httpOnly: true,
    });
    return cleanStaleCookies(req, response);
  }

  // -------------------------------------------------------------------------
  // 5. Authenticated but NOT onboarded → redirect to /onboarding
  //    (unless already on /onboarding)
  // -------------------------------------------------------------------------
  if (isAuthenticated && !req.auth?.user?.onboardingComplete) {
    if (
      !pathname.startsWith("/onboarding") &&
      !pathname.startsWith("/api/") &&
      !isPublicRoute
    ) {
      response = NextResponse.redirect(new URL("/onboarding", req.url));
      return cleanStaleCookies(req, response);
    }
  }

  // -------------------------------------------------------------------------
  // 6. Authenticated + onboarded + on /onboarding → redirect to /dashboard
  // -------------------------------------------------------------------------
  if (isAuthenticated && req.auth?.user?.onboardingComplete) {
    if (pathname.startsWith("/onboarding")) {
      response = NextResponse.redirect(new URL("/dashboard", req.url));
      return cleanStaleCookies(req, response);
    }
  }

  response = NextResponse.next();
  return cleanStaleCookies(req, response);
});

// =============================================================================
// Matcher — run middleware on these routes
// =============================================================================

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, robots.txt, manifest.json, icons
     */
    "/((?!_next/static|_next/image|api/auth|favicon.ico|robots.txt|manifest.json|sw\\.js|apple-touch-icon.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
