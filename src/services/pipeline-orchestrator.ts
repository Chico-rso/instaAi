import { randomUUID } from "node:crypto";

import { AppConfig } from "../config/env";
import { CaptionGenerator } from "../modules/caption-generator/caption-generator";
import { InstagramPublisher } from "../modules/instagram-publisher/instagram-publisher";
import { ScriptGenerator } from "../modules/script-generator/script-generator";
import { TelegramPublisher } from "../modules/telegram-publisher/telegram-publisher";
import { VideoGenerator } from "../modules/video-generator/video-generator";
import { JobRecord, RawTelegramPost } from "../types";
import { truncate } from "../utils/strings";
import { AppLogger } from "./logger";
import { JobStateStore } from "./job-state-store";
import { StorageService } from "./storage/storage-service";
import { TelegramReader } from "./telegram-reader/telegram-reader";

interface ProcessedPostResult {
  postId: string;
  captionPreview: string;
  reelVideoUrl?: string;
  reelThumbnailUrl?: string;
  telegramDeliveryChatId?: string;
  telegramVideoMessageId?: number;
  telegramCaptionMessageId?: number;
  instagramMediaId?: string;
  instagramContainerId?: string;
}

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
    private readonly telegramPublisher?: TelegramPublisher,
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
    options?: { force?: boolean; maxPosts?: number },
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
    options?: { force?: boolean; maxPosts?: number },
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
      const monthKey = this.getMonthKey(new Date());
      const monthlyLimit = this.config.pipeline.maxReelsPerMonth;
      const monthlyGeneratedBeforeRun = await this.stateStore.getGeneratedReelsCountForMonth(monthKey);
      const monthlyRemaining = monthlyLimit - monthlyGeneratedBeforeRun;
      const forceRun = options?.force === true;
      if (monthlyRemaining <= 0 && !forceRun) {
        return (await this.stateStore.updateJob(jobId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          quotaMonth: monthKey,
          monthlyLimit,
          monthlyGeneratedBeforeRun,
          monthlyGeneratedAfterRun: monthlyGeneratedBeforeRun,
          skipReason: `Monthly limit reached (${monthlyLimit}). Next batch available after ${this.getNextMonthIsoDate(new Date())}.`,
        })) as JobRecord;
      }

      const requestedMaxPosts = options?.maxPosts ?? this.config.pipeline.maxReelsPerRun;
      const maxPosts = Math.max(
        1,
        Math.min(
          this.config.pipeline.maxReelsPerRun,
          requestedMaxPosts,
          forceRun ? this.config.pipeline.maxReelsPerRun : monthlyRemaining,
        ),
      );
      const latestPosts = await this.telegramReader.getLatestPosts(maxPosts);
      if (!latestPosts.length) {
        return (await this.stateStore.updateJob(jobId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          quotaMonth: monthKey,
          monthlyLimit,
          monthlyGeneratedBeforeRun,
          monthlyGeneratedAfterRun: monthlyGeneratedBeforeRun,
          skipReason: "No Telegram channel post available yet.",
        })) as JobRecord;
      }

      let postsToProcess = options?.force
        ? latestPosts
        : await this.filterUnprocessedPosts(latestPosts);

      if (options?.force && postsToProcess.length < maxPosts && latestPosts[0]) {
        const extra = this.createForcedVariants(latestPosts[0], maxPosts - postsToProcess.length);
        postsToProcess = postsToProcess.concat(extra);
      }

      if (!postsToProcess.length) {
        return (await this.stateStore.updateJob(jobId, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          sourcePostId: latestPosts[0]?.id,
          quotaMonth: monthKey,
          monthlyLimit,
          monthlyGeneratedBeforeRun,
          monthlyGeneratedAfterRun: monthlyGeneratedBeforeRun,
          skipReason: "All fetched Telegram posts have already been processed.",
        })) as JobRecord;
      }

      const failedPostIds: string[] = [];
      const processedPostIds: string[] = [];
      let lastResult: ProcessedPostResult | undefined;

      for (const post of postsToProcess.sort((left, right) => left.messageId - right.messageId)) {
        try {
          const processed = await this.processPost(jobId, post);
          processedPostIds.push(post.id);
          lastResult = processed;
          await this.stateStore.markTelegramPostProcessed(post.id, jobId);
        } catch (error) {
          failedPostIds.push(post.id);
          this.logger.error(
            {
              jobId,
              postId: post.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to process Telegram post",
          );
        }
      }

      if (!processedPostIds.length) {
        return (await this.stateStore.updateJob(jobId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: `Failed to process all posts (${failedPostIds.length}).`,
          quotaMonth: monthKey,
          monthlyLimit,
          monthlyGeneratedBeforeRun,
          monthlyGeneratedAfterRun: monthlyGeneratedBeforeRun,
          failedPostIds,
          failedCount: failedPostIds.length,
        })) as JobRecord;
      }

      const monthlyGeneratedAfterRun = monthlyGeneratedBeforeRun + processedPostIds.length;
      const partialFailureMessage = failedPostIds.length
        ? `Processed ${processedPostIds.length} posts, failed ${failedPostIds.length}.`
        : undefined;

      return (await this.stateStore.updateJob(jobId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        sourcePostId: lastResult?.postId,
        reelVideoUrl: lastResult?.reelVideoUrl,
        reelThumbnailUrl: lastResult?.reelThumbnailUrl,
        captionPreview: lastResult?.captionPreview,
        telegramDeliveryChatId: lastResult?.telegramDeliveryChatId,
        telegramVideoMessageId: lastResult?.telegramVideoMessageId,
        telegramCaptionMessageId: lastResult?.telegramCaptionMessageId,
        instagramMediaId: lastResult?.instagramMediaId,
        instagramContainerId: lastResult?.instagramContainerId,
        processedPostIds,
        processedCount: processedPostIds.length,
        failedPostIds,
        failedCount: failedPostIds.length,
        quotaMonth: monthKey,
        monthlyLimit,
        monthlyGeneratedBeforeRun,
        monthlyGeneratedAfterRun,
        error: partialFailureMessage,
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

  private async filterUnprocessedPosts(posts: RawTelegramPost[]): Promise<RawTelegramPost[]> {
    const unprocessed: RawTelegramPost[] = [];
    for (const post of posts) {
      if (!(await this.stateStore.hasProcessedTelegramPost(post.id))) {
        unprocessed.push(post);
      }
    }
    return unprocessed;
  }

  private async processPost(jobId: string, post: RawTelegramPost): Promise<ProcessedPostResult> {
    const recentExamples = await this.stateStore.getRecentCaptionPreviews(6);
    const { structuredContent, reelScript } = await this.scriptGenerator.generate(post, {
      recentExamples,
    });
    const renderedReel = await this.videoGenerator.generate(jobId, reelScript);
    const captionPayload = await this.captionGenerator.generate(
      post,
      structuredContent,
      reelScript,
    );

    const suffix = `post-${post.messageId}`;
    const storedVideo = await this.storageService.persistPublicAsset(
      jobId,
      renderedReel.videoPath,
      `reel-${suffix}.mp4`,
      "video/mp4",
    );
    const storedThumbnail = await this.storageService.persistPublicAsset(
      jobId,
      renderedReel.thumbnailPath,
      `cover-${suffix}.jpg`,
      "image/jpeg",
    );

    await Promise.all([
      this.storageService.writeJobMetadata(jobId, `source-post-${suffix}.json`, post),
      this.storageService.writeJobMetadata(jobId, `structured-content-${suffix}.json`, structuredContent),
      this.storageService.writeJobMetadata(jobId, `reel-script-${suffix}.json`, reelScript),
      this.storageService.writeJobMetadata(jobId, `caption-${suffix}.json`, captionPayload),
    ]);

    let instagramMediaId: string | undefined;
    let instagramContainerId: string | undefined;
    let telegramDeliveryChatId: string | undefined;
    let telegramVideoMessageId: number | undefined;
    let telegramCaptionMessageId: number | undefined;

    if (this.config.telegram.deliveryEnabled) {
      if (!this.telegramPublisher) {
        throw new Error("Telegram delivery is enabled but publisher service is missing.");
      }

      if (!storedVideo.publicUrl) {
        throw new Error("Rendered Reel does not have a public URL for Telegram delivery.");
      }

      const delivered = await this.telegramPublisher.deliverReel({
        videoUrl: storedVideo.publicUrl,
        caption: captionPayload.caption,
        hashtags: captionPayload.hashtags,
        sourcePermalink: post.permalink,
      });
      telegramDeliveryChatId = delivered.chatId;
      telegramVideoMessageId = delivered.videoMessageId;
      telegramCaptionMessageId = delivered.captionMessageId;
    }

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

    return {
      postId: post.id,
      captionPreview: truncate(captionPayload.caption, 400),
      reelVideoUrl: storedVideo.publicUrl,
      reelThumbnailUrl: storedThumbnail.publicUrl,
      telegramDeliveryChatId,
      telegramVideoMessageId,
      telegramCaptionMessageId,
      instagramMediaId,
      instagramContainerId,
    };
  }

  private createJobId(): string {
    return `job-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  }

  private createForcedVariants(basePost: RawTelegramPost, count: number): RawTelegramPost[] {
    const variants: RawTelegramPost[] = [];
    for (let index = 1; index <= count; index += 1) {
      variants.push({
        ...basePost,
        id: `${basePost.id}::variant-${index}`,
        messageId: basePost.messageId + index * 100_000,
        text: `${basePost.text}\n\n[Вариант ${index}: измени подачу и угол истории, сохрани вирусный стиль.]`,
      });
    }
    return variants;
  }

  private getMonthKey(date: Date): string {
    return date.toISOString().slice(0, 7);
  }

  private getNextMonthIsoDate(date: Date): string {
    const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    return nextMonth.toISOString().slice(0, 10);
  }
}
