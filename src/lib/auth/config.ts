// =============================================================================
// Auth.js (NextAuth v5) Configuration
// =============================================================================
// Providers: Google OAuth, Apple OAuth, Email Magic Link (Resend)
// Strategy: JWT (30-day expiry)
// Adapter: Custom Drizzle adapter mapping to our users table
// =============================================================================

import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import Resend from "next-auth/providers/resend";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema/users";
import { HuntLogicDrizzleAdapter } from "./adapter";
import { config } from "@/lib/config";
import { isEmailAllowed } from "./allowlist";

// =============================================================================
// Type augmentation for Auth.js
// =============================================================================

declare module "next-auth" {
  interface Session {
    user: {
      id: string; // Our DB user UUID
      email: string;
      name?: string;
      image?: string;
      onboardingComplete: boolean;
      onboardingStep: string;
    };
  }
}

// JWT extension: userId, onboardingComplete, onboardingStep
// are added via the jwt callback below and typed via `as` casts

// =============================================================================
// Auth configuration
// =============================================================================

export const authConfig: NextAuthConfig = {
  adapter: HuntLogicDrizzleAdapter(),

  // Trust the host header — required for Vercel deployments where the
  // canonical URL may differ from the request host (e.g. preview URLs)
  trustHost: true,

  // ⚠️  DO NOT REMOVE THIS COOKIE CONFIG — IT FIXES THE SSO LOGIN LOOP  ⚠️
  // useSecureCookies:true (the default for https) adds __Host-/__Secure-
  // prefixes to cookie names. These prefixed cookies are NOT reliably sent
  // with fetch() POST or native form POST in all browsers, causing
  // MissingCSRF errors. Setting useSecureCookies:false and manually
  // specifying each cookie with secure:true gives us HTTPS security
  // WITHOUT the broken prefixes.
  // See: SSO Incident 2026-03-15, commits c883670, 876faf2
  useSecureCookies: false,
  cookies: {
    csrfToken: {
      name: "authjs.csrf-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    callbackUrl: {
      name: "authjs.callback-url",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    sessionToken: {
      name: "authjs.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    pkceCodeVerifier: {
      name: "authjs.pkce.code_verifier",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    state: {
      name: "authjs.state",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    nonce: {
      name: "authjs.nonce",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
  },

  // ---------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
      // Use "state" check instead of "pkce" to avoid PKCE cookie
      // encryption/decryption salt mismatch between signin and callback.
      // The PKCE cookie encryption salt is the cookie name — if there's
      // ANY inconsistency between deployments or cookie configs, the
      // encrypted PKCE value can't be decrypted → InvalidCheck → error=Configuration.
      // State check is equally secure for server-side OAuth.
      checks: ["state"],
    }),

    // Apple — only register if credentials are configured
    ...(process.env.APPLE_ID && process.env.APPLE_PRIVATE_KEY
      ? [
          Apple({
            clientId: process.env.APPLE_ID,
            clientSecret: {
              teamId: process.env.APPLE_TEAM_ID!,
              privateKey: process.env.APPLE_PRIVATE_KEY,
              keyId: process.env.APPLE_KEY_ID!,
            } as unknown as string,
          }),
        ]
      : []),

    // Resend email — only register if API key is configured
    ...(process.env.RESEND_API_KEY
      ? [
          Resend({
            apiKey: process.env.RESEND_API_KEY,
            from: config.auth.emailFrom,
          }),
        ]
      : []),
  ],

  // ---------------------------------------------------------------------------
  // Session strategy
  // ---------------------------------------------------------------------------
  session: {
    strategy: "jwt",
    maxAge: config.cache.sessionMaxAge,
  },

  // ---------------------------------------------------------------------------
  // Custom pages
  // ---------------------------------------------------------------------------
  pages: {
    signIn: "/login",
    newUser: "/onboarding",
    error: "/login",
  },

  // ---------------------------------------------------------------------------
  // Callbacks
  // ---------------------------------------------------------------------------
  callbacks: {
    /**
     * signIn: On first sign-in, create user record if not exists.
     * Sets onboarding_step = 'welcome', onboarding_complete = false.
     */
    async signIn({ user, account }) {
      if (!user.email) return false;

      // Private-beta gate. When ALLOWED_EMAILS is set, only listed emails
      // (plus ADMIN_EMAILS) may sign in. Empty allowlist = open to all.
      if (!isEmailAllowed(user.email, process.env.ALLOWED_EMAILS, process.env.ADMIN_EMAILS)) {
        console.warn(`[auth] Blocked sign-in — not on beta allowlist: ${user.email}`);
        return false;
      }

      try {
        // Check if user exists in our DB
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, user.email.toLowerCase()),
        });

        if (!existingUser) {
          // User will be created by the adapter's createUser method
          // which is called automatically by Auth.js for new users
          console.log(
            `[auth] New sign-in detected for ${user.email} via ${account?.provider}`
          );
        } else {
          console.log(
            `[auth] Returning user sign-in: ${existingUser.id} via ${account?.provider}`
          );
        }

        return true;
      } catch (error) {
        console.error("[auth] signIn callback error:", error);
        return false;
      }
    },

    /**
     * jwt: Add userId, onboardingComplete, and onboardingStep to JWT token.
     */
    async jwt({ token, user, trigger }) {
      console.log(`[auth:jwt] trigger=${trigger} user=${user?.email ?? 'none'} sub=${token.sub}`);
      const t = token as Record<string, unknown>;

      // Only query DB on explicit signIn/update triggers (runs on Node.js λ).
      // DO NOT query DB on regular requests — the middleware runs on Edge (ε)
      // which cannot connect to PostgreSQL. The DB query throws on Edge,
      // causing JWTSessionError → infinite login redirect loop.
      // Values set during signIn persist in the JWT across requests.
      const needsRefresh =
        trigger === "signIn" || trigger === "update";

      if (needsRefresh) {
        const email = user?.email ?? (t.email as string | undefined);
        if (email) {
          try {
            const dbUser = await db.query.users.findFirst({
              where: eq(users.email, email.toLowerCase()),
            });

            if (dbUser) {
              t.userId = dbUser.id;
              t.onboardingComplete = dbUser.onboardingComplete;
              t.onboardingStep = dbUser.onboardingStep;
            }
          } catch (err) {
            console.error("[auth:jwt] DB lookup failed (expected on Edge):", err);
          }
        }
      }

      return token;
    },

    /**
     * session: Expose userId, onboardingComplete, onboardingStep in session.
     */
    async session({ session, token }) {
      console.log(`[auth:session] userId=${(token as Record<string,unknown>).userId} onboarding=${(token as Record<string,unknown>).onboardingComplete}`);
      const t = token as Record<string, unknown>;
      if (t.userId) {
        session.user.id = t.userId as string;
        session.user.onboardingComplete = (t.onboardingComplete as boolean) ?? false;
        session.user.onboardingStep = (t.onboardingStep as string) ?? "welcome";
      }

      return session;
    },
  },

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  events: {
    async createUser({ user }) {
      console.log(
        `[auth] New user created: ${user.id} (${user.email}). Sending welcome notification.`
      );

      // Send welcome notification (in-app + email via notification service)
      if (user.id) {
        try {
          const { createNotification } = await import(
            "@/services/notifications/index"
          );

          await createNotification({
            userId: user.id,
            type: "welcome",
            title: `Welcome to ${config.app.brandName}!`,
            body: "Your AI-powered hunting concierge is ready. Complete your profile to get personalized draw recommendations, point tracking, and multi-year strategy playbooks tailored to your goals.",
            actionUrl: "/onboarding",
          });

          console.log(`[auth] Welcome notification sent to user ${user.id}`);
        } catch (err) {
          // Non-blocking — don't fail signup if notification fails
          console.warn("[auth] Failed to send welcome notification:", err);
        }
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Debug mode in development
  // ---------------------------------------------------------------------------
  debug: process.env.NODE_ENV === "development" || process.env.AUTH_DEBUG === "true",
};
