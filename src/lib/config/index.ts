/**
 * Application configuration loader.
 * Centralizes access to environment variables with type safety.
 */

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

export const config = {
  app: {
    url: optionalEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
    name: optionalEnv("NEXT_PUBLIC_APP_NAME", "HuntLogic Concierge"),
    brandName: optionalEnv("NEXT_PUBLIC_BRAND_NAME", "HuntLogic"),
    aiAssistantName: optionalEnv("NEXT_PUBLIC_AI_ASSISTANT_NAME", "Teddy"),
    supportEmail: optionalEnv("SUPPORT_EMAIL", "support@huntlogic.com"),
    telegramBot: optionalEnv("TELEGRAM_BOT_HANDLE", "@TeddyLogicBot"),
    brandColor: optionalEnv("BRAND_PRIMARY_COLOR", "#1A3C2A"),
    brandAccent: optionalEnv("BRAND_ACCENT_COLOR", "#C4651A"),
    brandAccentSecondary: optionalEnv("BRAND_ACCENT_SECONDARY", "#D4A03C"),
    env: optionalEnv("NODE_ENV", "development"),
    isDev: process.env.NODE_ENV === "development",
    isProd: process.env.NODE_ENV === "production",
  },

  database: {
    url: () => requireEnv("DATABASE_URL"),
    poolSize: Number(optionalEnv("DATABASE_POOL_SIZE", "10")),
  },

  redis: {
    url: optionalEnv("REDIS_URL", "redis://localhost:6379"),
    password: optionalEnv("REDIS_PASSWORD"),
  },

  auth: {
    secret: () => requireEnv("NEXTAUTH_SECRET"),
    url: optionalEnv("NEXTAUTH_URL", "http://localhost:3000"),
    googleClientId: optionalEnv("GOOGLE_CLIENT_ID"),
    googleClientSecret: optionalEnv("GOOGLE_CLIENT_SECRET"),
    appleId: optionalEnv("APPLE_ID"),
    appleTeamId: optionalEnv("APPLE_TEAM_ID"),
    appleKeyId: optionalEnv("APPLE_KEY_ID"),
    resendApiKey: optionalEnv("RESEND_API_KEY"),
    emailFrom: optionalEnv("EMAIL_FROM", "HuntLogic <noreply@huntlogic.com>"),
  },

  ai: {
    apiKey: () => requireEnv("ANTHROPIC_API_KEY"),
    model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
    advancedModel: optionalEnv(
      "ANTHROPIC_MODEL_ADVANCED",
      "claude-sonnet-4-20250514"
    ),
    embeddingModel: optionalEnv("EMBEDDING_MODEL", "gemini-embedding-001"),
  },

  rateLimit: {
    windowMs: Number(optionalEnv("RATE_LIMIT_WINDOW_MS", "60000")),
    maxRequests: Number(optionalEnv("RATE_LIMIT_MAX_REQUESTS", "100")),
    simulationMaxPerMin: Number(optionalEnv("RATE_LIMIT_SIMULATION", "5")),
    credentialMaxPerHour: Number(optionalEnv("RATE_LIMIT_CREDENTIALS", "5")),
  },

  cache: {
    promptTtlMs: Number(optionalEnv("CACHE_PROMPT_TTL_MS", "300000")),
    configTtlMs: Number(optionalEnv("CACHE_CONFIG_TTL_MS", "300000")),
    sessionMaxAge: Number(optionalEnv("SESSION_MAX_AGE", String(30 * 24 * 60 * 60))),
  },

  search: {
    host: optionalEnv("MEILISEARCH_HOST", "http://localhost:7700"),
    apiKey: optionalEnv("MEILISEARCH_API_KEY"),
  },

  storage: {
    endpoint: optionalEnv("MINIO_ENDPOINT", "localhost"),
    port: Number(optionalEnv("MINIO_PORT", "9000")),
    accessKey: optionalEnv("MINIO_ACCESS_KEY"),
    secretKey: optionalEnv("MINIO_SECRET_KEY"),
    bucket: optionalEnv("MINIO_BUCKET", "huntlogic-data"),
    useSSL: optionalEnv("MINIO_USE_SSL", "false") === "true",
  },

  forecasting: {
    apiUrl: optionalEnv("FORECASTING_API_URL", "http://localhost:8000"),
  },

  messaging: {
    telegram: {
      // Bot API token from @BotFather.
      botToken: optionalEnv("TELEGRAM_BOT_TOKEN"),
      // Public bot handle, e.g. "@HuntLogicBot". Also exposed at app.telegramBot.
      botHandle: optionalEnv("TELEGRAM_BOT_HANDLE", "@TeddyLogicBot"),
      // Secret passed to setWebhook + echoed back in the
      // X-Telegram-Bot-Api-Secret-Token header on every inbound update.
      webhookSecret: optionalEnv("TELEGRAM_WEBHOOK_SECRET"),
    },
  },

  stripe: {
    secretKey: () => requireEnv("STRIPE_SECRET_KEY"),
    publishableKey: optionalEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"),
    webhookSecret: () => requireEnv("STRIPE_WEBHOOK_SECRET"),
    currency: optionalEnv("STRIPE_CURRENCY", "usd"),
  },

  features: {
    aiChat: optionalEnv("ENABLE_AI_CHAT", "true") === "true",
    forecasting: optionalEnv("ENABLE_FORECASTING", "true") === "true",
    pushNotifications:
      optionalEnv("ENABLE_PUSH_NOTIFICATIONS", "false") === "true",
    mapFeatures: optionalEnv("ENABLE_MAP_FEATURES", "true") === "true",
    // Telegram concierge channel ("Grizz in your pocket"). Off by default —
    // gates the linking UI, the webhook, and the admin setup endpoint.
    telegramBot: optionalEnv("ENABLE_TELEGRAM_BOT", "false") === "true",
  },
} as const;

export type AppConfig = typeof config;
