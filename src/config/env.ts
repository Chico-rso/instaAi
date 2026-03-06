import { resolve } from "node:path";
import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }

      if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
      }
    }

    return value;
  }, z.boolean()).default(defaultValue);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  SCHEDULER_ENABLED: envBoolean(true),
  CRON_SCHEDULE: z.string().default("0 */4 * * *"),
  TIMEZONE: z.string().default("Europe/Moscow"),
  MANUAL_TRIGGER_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  APP_BASE_PATH: z.string().default(""),
  OUTBOUND_PROXY_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  MAX_REELS_PER_RUN: z.coerce.number().int().min(1).max(10).default(10),
  MAX_REELS_PER_MONTH: z.coerce.number().int().min(1).max(10).default(10),

  GLM_API_KEY: z.string().min(1),
  GLM_API_BASE_URL: z.string().url().default("https://api.z.ai/api/paas/v4"),
  GLM_MODEL: z.string().default("glm-5"),

  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  PROCESS_ON_WEBHOOK: envBoolean(false),
  TELEGRAM_DELIVERY_ENABLED: envBoolean(true),
  TELEGRAM_DELIVERY_CHAT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_DELIVERY_DISABLE_NOTIFICATION: envBoolean(false),

  INSTAGRAM_ENABLED: envBoolean(true),
  INSTAGRAM_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  IG_USER_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  INSTAGRAM_API_VERSION: z.string().default("v24.0"),
  INSTAGRAM_SHARE_TO_FEED: envBoolean(true),
  INSTAGRAM_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  INSTAGRAM_APP_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  INSTAGRAM_AUTH_MODE: z.enum(["facebook-login", "instagram-login"]).default("instagram-login"),
  INSTAGRAM_GRAPH_BASE_URL: z.string().url().default("https://graph.instagram.com"),
  INSTAGRAM_PROFILE_BASE_URL: z.string().url().default("https://graph.instagram.com"),
  INSTAGRAM_AUTH_BASE_URL: z.string().url().default("https://www.instagram.com/oauth/authorize"),
  INSTAGRAM_TOKEN_BASE_URL: z.string().url().default("https://api.instagram.com/oauth/access_token"),
  INSTAGRAM_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().url().optional()),
  INSTAGRAM_SCOPES: z.string().default("instagram_business_basic,instagram_business_content_publish"),
  INSTAGRAM_FORCE_REAUTH: envBoolean(true),

  VIDEO_PROVIDER: z.enum(["template", "pika"]).default("template"),

  PIKA_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  PIKA_BASE_URL: z.string().url().default("https://queue.fal.run"),
  PIKA_MODEL: z.string().default("fal-ai/pika/v2.2/text-to-video"),
  PIKA_ASPECT_RATIO: z.string().default("9:16"),
  PIKA_DURATION_SEC: z.coerce.number().int().positive().default(10),
  PIKA_NEGATIVE_PROMPT: z.preprocess(emptyToUndefined, z.string().optional()),
  PIKA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PIKA_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(8 * 60_000),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  STATE_DIR: z.string().default("./data/state"),
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_FORCE_PATH_STYLE: envBoolean(false),
  S3_PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  REEL_TEMPLATE_FILE: z.string().default("./templates/reel-default-template.json"),
  REEL_FONT_FILE: z.string().default("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
  REEL_FPS: z.coerce.number().int().positive().default(30),
  REEL_WIDTH: z.coerce.number().int().positive().default(1080),
  REEL_HEIGHT: z.coerce.number().int().positive().default(1920),
  REEL_AUDIO_FILE: z.preprocess(emptyToUndefined, z.string().optional()),
  REEL_AUDIO_VOLUME: z.coerce.number().min(0).max(3).default(0.25),
});

export interface AppConfig {
  port: number;
  logLevel: string;
  scheduler: {
    enabled: boolean;
    schedule: string;
    timezone: string;
  };
  http: {
    manualTriggerToken?: string;
    basePath: string;
    outboundProxyUrl?: string;
  };
  pipeline: {
    maxReelsPerRun: number;
    maxReelsPerMonth: number;
  };
  glm: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  telegram: {
    mode: "polling" | "webhook";
    botToken: string;
    channel: string;
    webhookSecret?: string;
    processOnWebhook: boolean;
    deliveryEnabled: boolean;
    deliveryChatId?: string;
    deliveryDisableNotification: boolean;
  };
  instagram: {
    enabled: boolean;
    accessToken?: string;
    userId?: string;
    apiVersion: string;
    shareToFeed: boolean;
    pollIntervalMs: number;
    pollTimeoutMs: number;
    appId?: string;
    appSecret?: string;
    authMode: "facebook-login" | "instagram-login";
    graphBaseUrl: string;
    profileBaseUrl: string;
    authBaseUrl: string;
    tokenBaseUrl: string;
    redirectUri?: string;
    scopes: string[];
    forceReauth: boolean;
  };
  video: {
    provider: "template" | "pika";
  };
  pika: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    aspectRatio: string;
    durationSec: number;
    negativePrompt?: string;
    pollIntervalMs: number;
    pollTimeoutMs: number;
  };
  storage: {
    driver: "local" | "s3";
    artifactDir: string;
    stateDir: string;
    publicBaseUrl?: string;
    s3?: {
      region: string;
      endpoint?: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
      publicBaseUrl: string;
    };
  };
  reel: {
    templateFile: string;
    fontFile: string;
    fps: number;
    width: number;
    height: number;
    audioFile?: string;
    audioVolume: number;
  };
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const resolvedVideoProvider = parsed.VIDEO_PROVIDER;

  if (parsed.STORAGE_DRIVER === "local" && parsed.INSTAGRAM_ENABLED && !parsed.PUBLIC_BASE_URL) {
    throw new Error("Local storage publishing requires PUBLIC_BASE_URL so Instagram can fetch rendered videos.");
  }

  if (resolvedVideoProvider === "pika" && !parsed.PIKA_API_KEY) {
    throw new Error("VIDEO_PROVIDER=pika requires PIKA_API_KEY.");
  }

  if (parsed.STORAGE_DRIVER === "s3") {
    if (
      !parsed.S3_BUCKET ||
      !parsed.S3_ACCESS_KEY_ID ||
      !parsed.S3_SECRET_ACCESS_KEY ||
      !parsed.S3_PUBLIC_BASE_URL
    ) {
      throw new Error("S3 storage requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_PUBLIC_BASE_URL.");
    }
  }

  return {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    scheduler: {
      enabled: parsed.SCHEDULER_ENABLED,
      schedule: parsed.CRON_SCHEDULE,
      timezone: parsed.TIMEZONE,
    },
    http: {
      manualTriggerToken: parsed.MANUAL_TRIGGER_TOKEN,
      basePath: normalizeBasePath(parsed.APP_BASE_PATH),
      outboundProxyUrl: parsed.OUTBOUND_PROXY_URL,
    },
    pipeline: {
      maxReelsPerRun: parsed.MAX_REELS_PER_RUN,
      maxReelsPerMonth: parsed.MAX_REELS_PER_MONTH,
    },
    glm: {
      apiKey: parsed.GLM_API_KEY,
      baseUrl: parsed.GLM_API_BASE_URL.replace(/\/$/, ""),
      model: parsed.GLM_MODEL,
    },
    telegram: {
      mode: parsed.TELEGRAM_MODE,
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      channel: parsed.TELEGRAM_CHANNEL,
      webhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
      processOnWebhook: parsed.PROCESS_ON_WEBHOOK,
      deliveryEnabled: parsed.TELEGRAM_DELIVERY_ENABLED,
      deliveryChatId: parsed.TELEGRAM_DELIVERY_CHAT_ID,
      deliveryDisableNotification: parsed.TELEGRAM_DELIVERY_DISABLE_NOTIFICATION,
    },
    instagram: {
      enabled: parsed.INSTAGRAM_ENABLED,
      accessToken: parsed.INSTAGRAM_ACCESS_TOKEN,
      userId: parsed.IG_USER_ID,
      apiVersion: parsed.INSTAGRAM_API_VERSION,
      shareToFeed: parsed.INSTAGRAM_SHARE_TO_FEED,
      pollIntervalMs: 10_000,
      pollTimeoutMs: 10 * 60_000,
      appId: parsed.INSTAGRAM_APP_ID,
      appSecret: parsed.INSTAGRAM_APP_SECRET,
      authMode: parsed.INSTAGRAM_AUTH_MODE,
      graphBaseUrl: parsed.INSTAGRAM_GRAPH_BASE_URL.replace(/\/$/, ""),
      profileBaseUrl: parsed.INSTAGRAM_PROFILE_BASE_URL.replace(/\/$/, ""),
      authBaseUrl: parsed.INSTAGRAM_AUTH_BASE_URL.replace(/\/$/, ""),
      tokenBaseUrl: parsed.INSTAGRAM_TOKEN_BASE_URL,
      redirectUri: parsed.INSTAGRAM_REDIRECT_URI,
      scopes: parsed.INSTAGRAM_SCOPES.split(",").map((item) => item.trim()).filter(Boolean),
      forceReauth: parsed.INSTAGRAM_FORCE_REAUTH,
    },
    video: {
      provider: resolvedVideoProvider,
    },
    pika: {
      apiKey: parsed.PIKA_API_KEY,
      baseUrl: parsed.PIKA_BASE_URL.replace(/\/$/, ""),
      model: parsed.PIKA_MODEL.replace(/^\/+|\/+$/g, ""),
      aspectRatio: parsed.PIKA_ASPECT_RATIO,
      durationSec: Math.max(5, Math.min(parsed.PIKA_DURATION_SEC, 10)),
      negativePrompt: parsed.PIKA_NEGATIVE_PROMPT,
      pollIntervalMs: parsed.PIKA_POLL_INTERVAL_MS,
      pollTimeoutMs: parsed.PIKA_POLL_TIMEOUT_MS,
    },
    storage: {
      driver: parsed.STORAGE_DRIVER,
      artifactDir: resolve(parsed.ARTIFACT_DIR),
      stateDir: resolve(parsed.STATE_DIR),
      publicBaseUrl: parsed.PUBLIC_BASE_URL,
      s3:
        parsed.STORAGE_DRIVER === "s3"
          ? {
              region: parsed.S3_REGION,
              endpoint: parsed.S3_ENDPOINT || undefined,
              bucket: parsed.S3_BUCKET as string,
              accessKeyId: parsed.S3_ACCESS_KEY_ID as string,
              secretAccessKey: parsed.S3_SECRET_ACCESS_KEY as string,
              forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
              publicBaseUrl: parsed.S3_PUBLIC_BASE_URL as string,
            }
          : undefined,
    },
    reel: {
      templateFile: resolve(parsed.REEL_TEMPLATE_FILE),
      fontFile: resolve(parsed.REEL_FONT_FILE),
      fps: parsed.REEL_FPS,
      width: parsed.REEL_WIDTH,
      height: parsed.REEL_HEIGHT,
      audioFile: parsed.REEL_AUDIO_FILE ? resolve(parsed.REEL_AUDIO_FILE) : undefined,
      audioVolume: parsed.REEL_AUDIO_VOLUME,
    },
  };
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}
