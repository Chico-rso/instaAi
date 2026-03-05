import "dotenv/config";

import express, { NextFunction, Request, Response } from "express";
import cron from "node-cron";

import { loadConfig } from "./config/env";
import { CaptionGenerator } from "./modules/caption-generator/caption-generator";
import { InstagramPublisher } from "./modules/instagram-publisher/instagram-publisher";
import { ScriptGenerator } from "./modules/script-generator/script-generator";
import { TelegramPublisher } from "./modules/telegram-publisher/telegram-publisher";
import { VideoGenerator } from "./modules/video-generator/video-generator";
import { GlmClient } from "./services/ai-client/glm-client";
import { FfmpegRenderer } from "./services/ffmpeg-renderer/ffmpeg-renderer";
import { configureHttpClient } from "./services/http-client";
import { InstagramAuthService } from "./services/instagram-auth-service";
import { InstagramAuthStore } from "./services/instagram-auth-store";
import { JobStateStore } from "./services/job-state-store";
import { createLogger } from "./services/logger";
import { PipelineOrchestrator } from "./services/pipeline-orchestrator";
import { PikaClient } from "./services/pika-client";
import { StorageService } from "./services/storage/storage-service";
import { TelegramReader } from "./services/telegram-reader/telegram-reader";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  configureHttpClient(config.http.outboundProxyUrl, logger);

  const stateStore = new JobStateStore(config.storage.stateDir);
  const instagramAuthStore = new InstagramAuthStore(config.storage.stateDir);
  const glmClient = new GlmClient(config.glm, logger);
  const telegramReader = new TelegramReader(config.telegram, stateStore, logger);
  const ffmpegRenderer = new FfmpegRenderer(config.reel.fontFile, logger);
  const pikaClient = config.video.provider === "pika"
    ? new PikaClient(config.pika, logger)
    : undefined;
  const storageService = new StorageService(config.storage, logger);
  const scriptGenerator = new ScriptGenerator(glmClient, logger);
  const captionGenerator = new CaptionGenerator(glmClient, logger);
  const videoGenerator = new VideoGenerator(config, ffmpegRenderer, logger, pikaClient);
  const telegramPublisher = config.telegram.deliveryEnabled
    ? new TelegramPublisher(config.telegram, logger)
    : undefined;
  const instagramPublisher = config.instagram.enabled
    ? new InstagramPublisher(config.instagram, logger, instagramAuthStore)
    : undefined;
  const instagramAuthService = new InstagramAuthService(
    config.instagram,
    instagramAuthStore,
    logger,
  );
  const orchestrator = new PipelineOrchestrator(
    config,
    stateStore,
    telegramReader,
    scriptGenerator,
    videoGenerator,
    captionGenerator,
    storageService,
    logger,
    telegramPublisher,
    instagramPublisher,
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const router = express.Router();

  router.get("/health", (_request, response) => {
    response.json({
      ok: true,
      schedulerEnabled: config.scheduler.enabled,
      telegramMode: config.telegram.mode,
      instagramEnabled: config.instagram.enabled,
      instagramAuthMode: config.instagram.authMode,
      videoProvider: config.video.provider,
      running: orchestrator.isRunning(),
    });
  });

  router.get("/robots.txt", (_request, response) => {
    response.type("text/plain").send(
      [
        "User-agent: *",
        "Disallow:",
        "",
        "User-agent: facebookexternalhit",
        "Disallow:",
        "",
        "User-agent: Meta-ExternalAgent",
        "Disallow:",
        "",
      ].join("\n"),
    );
  });

  router.get("/auth/instagram/start", async (_request, response, next) => {
    try {
      const authorizationUrl = instagramAuthService.getAuthorizationUrl();
      response.redirect(302, authorizationUrl);
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/instagram/callback", async (request, response, next) => {
    try {
      const code = typeof request.query.code === "string" ? request.query.code : undefined;
      if (!code) {
        throw new Error("Instagram callback did not include an authorization code.");
      }

      const session = await instagramAuthService.exchangeCode(code);
      response.status(200).send(`
        <html>
          <body style="font-family: sans-serif; padding: 24px;">
            <h1>Instagram connected</h1>
            <p>Username: <strong>${session.user.username ?? "unknown"}</strong></p>
            <p>IG User ID: <strong>${session.user.id}</strong></p>
            <p>Access token saved to server state.</p>
          </body>
        </html>
      `);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/instagram/session", ensureManualAuth(config.http.manualTriggerToken), async (_request, response) => {
    const session = await instagramAuthService.getSession();
    if (!session) {
      response.status(404).json({ error: "No Instagram auth session saved yet." });
      return;
    }

    response.json({
      username: session.user.username,
      userId: session.user.id,
      accountType: session.user.accountType,
      expiresAt: session.expiresAt,
      issuedAt: session.issuedAt,
      scopes: session.scopes,
    });
  });

  router.post("/api/pipeline/run", ensureManualAuth(config.http.manualTriggerToken), async (request, response, next) => {
    try {
      const force = request.body?.force === true;
      const job = await orchestrator.run("manual", { force });
      response.status(job.status === "failed" ? 500 : 200).json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/jobs/:jobId", ensureManualAuth(config.http.manualTriggerToken), async (request, response) => {
    const jobId = Array.isArray(request.params.jobId)
      ? request.params.jobId[0]
      : request.params.jobId;
    const job = await orchestrator.getJob(jobId);
    if (!job) {
      response.status(404).json({ error: "Job not found" });
      return;
    }

    response.json(job);
  });

  router.post("/api/telegram/webhook", async (request, response, next) => {
    try {
      const post = await telegramReader.captureWebhookUpdate(
        request.body,
        request.header("x-telegram-bot-api-secret-token") || undefined,
      );

      if (config.telegram.processOnWebhook && post) {
        void orchestrator.run("webhook").catch((error) => {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "Webhook-triggered pipeline run failed",
          );
        });
      }

      response.status(202).json({
        ok: true,
        postId: post?.id,
      });
    } catch (error) {
      next(error);
    }
  });

  router.use("/assets", express.static(storageService.getPublicAssetsRoot()));
  app.use(config.http.basePath || "/", router);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    const statusCode = /already in progress/i.test(message) ? 409 : 500;
    logger.error(
      {
        error: message,
      },
      "HTTP request failed",
    );
    response.status(statusCode).json({
      error: message,
    });
  });

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        schedulerEnabled: config.scheduler.enabled,
        telegramMode: config.telegram.mode,
      },
      "Instagram Reels automation service started",
    );
  });

  if (config.scheduler.enabled) {
    cron.schedule(
      config.scheduler.schedule,
      () => {
        void orchestrator.run("cron").catch((error) => {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "Scheduled pipeline run failed",
          );
        });
      },
      {
        timezone: config.scheduler.timezone,
      },
    );
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down service");
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function ensureManualAuth(token?: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }

    const authorization = request.header("authorization");
    if (authorization !== `Bearer ${token}`) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}

void main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL || "info");
  logger.error(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    "Fatal startup error",
  );
  process.exit(1);
});
