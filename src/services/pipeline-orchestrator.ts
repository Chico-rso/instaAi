import { randomUUID } from "node:crypto";

import { AppConfig } from "../config/env";
import { CaptionGenerator } from "../modules/caption-generator/caption-generator";
import { InstagramPublisher } from "../modules/instagram-publisher/instagram-publisher";
import { ScriptGenerator } from "../modules/script-generator/script-generator";
import { VideoGenerator } from "../modules/video-generator/video-generator";
import { JobRecord } from "../types";
import { truncate } from "../utils/strings";
import { AppLogger } from "./logger";
import { JobStateStore } from "./job-state-store";
import { StorageService } from "./storage/storage-service";
import { TelegramReader } from "./telegram-reader/telegram-reader";

export class PipelineOrchestrator {
  private activeRun?: Promise<JobRecord>;

  constructor(
    private readonly config: AppConfig,
    private readonly stateStore: JobStateStore,
    private readonly telegramReader: TelegramReader,
    private readonly scriptGenerator: ScriptGenerator,
    private readonly videoGenerator: VideoGenerator,
    private readonly captionGenerator: CaptionGenerator,
    private readonly storageService: StorageService,
    private readonly logger: AppLogger,
    private readonly instagramPublisher?: InstagramPublisher,
  ) {}

  isRunning(): boolean {
    return Boolean(this.activeRun);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    return this.stateStore.getJob(jobId);
  }

  async run(
    trigger: "cron" | "manual" | "webhook",
    options?: { force?: boolean },
  ): Promise<JobRecord> {
    if (this.activeRun) {
      throw new Error("Pipeline run already in progress.");
    }

    const runPromise = this.runInternal(trigger, options);
    this.activeRun = runPromise;

    try {
      return await runPromise;
    } finally {
      this.activeRun = undefined;
    }
  }

  private async runInternal(
    trigger: "cron" | "manual" | "webhook",
    options?: { force?: boolean },
  ): Promise<JobRecord> {
    const jobId = this.createJobId();
    const startedAt = new Date().toISOString();
    const job: JobRecord = {
      id: jobId,
      trigger,
      status: "running",
      createdAt: startedAt,
    };

    await this.stateStore.createJob(job);

    try {
      const latestPost = await this.telegramReader.getLatestPost();
      if (!latestPost) {
        return (await this.stateStore.updateJob(jobId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          skipReason: "No Telegram channel post available yet.",
        })) as JobRecord;
      }

      if (!options?.force && (await this.stateStore.hasProcessedTelegramPost(latestPost.id))) {
        return (await this.stateStore.updateJob(jobId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          sourcePostId: latestPost.id,
          skipReason: "Latest Telegram post has already been processed.",
        })) as JobRecord;
      }

      const { structuredContent, reelScript } = await this.scriptGenerator.generate(latestPost);
      const renderedReel = await this.videoGenerator.generate(jobId, reelScript);
      const captionPayload = await this.captionGenerator.generate(
        latestPost,
        structuredContent,
        reelScript,
      );

      const storedVideo = await this.storageService.persistPublicAsset(
        jobId,
        renderedReel.videoPath,
        "reel.mp4",
        "video/mp4",
      );
      const storedThumbnail = await this.storageService.persistPublicAsset(
        jobId,
        renderedReel.thumbnailPath,
        "cover.jpg",
        "image/jpeg",
      );

      await Promise.all([
        this.storageService.writeJobMetadata(jobId, "source-post.json", latestPost),
        this.storageService.writeJobMetadata(jobId, "structured-content.json", structuredContent),
        this.storageService.writeJobMetadata(jobId, "reel-script.json", reelScript),
        this.storageService.writeJobMetadata(jobId, "caption.json", captionPayload),
      ]);

      let instagramMediaId: string | undefined;
      let instagramContainerId: string | undefined;

      if (this.config.instagram.enabled) {
        if (!this.instagramPublisher) {
          throw new Error("Instagram publishing is enabled but publisher service is missing.");
        }

        if (!storedVideo.publicUrl) {
          throw new Error("Rendered Reel does not have a public URL for Instagram publishing.");
        }

        const captionText = [
          captionPayload.caption,
          captionPayload.hashtags.join(" "),
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 2_200);

        const published = await this.instagramPublisher.publishReel({
          videoUrl: storedVideo.publicUrl,
          caption: captionText,
        });
        instagramMediaId = published.mediaId;
        instagramContainerId = published.containerId;
      }

      await this.stateStore.markTelegramPostProcessed(latestPost.id, jobId);

      return (await this.stateStore.updateJob(jobId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        sourcePostId: latestPost.id,
        reelVideoUrl: storedVideo.publicUrl,
        reelThumbnailUrl: storedThumbnail.publicUrl,
        captionPreview: truncate(captionPayload.caption, 400),
        instagramMediaId,
        instagramContainerId,
      })) as JobRecord;
    } catch (error) {
      this.logger.error(
        {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Pipeline execution failed",
      );

      return (await this.stateStore.updateJob(jobId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })) as JobRecord;
    }
  }

  private createJobId(): string {
    return `job-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  }
}
