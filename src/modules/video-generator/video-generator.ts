import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig } from "../../config/env";
import { ReelScript, ReelTemplate, RenderedReel, TimedReelScene } from "../../types";
import { FfmpegRenderer } from "../../services/ffmpeg-renderer/ffmpeg-renderer";
import { HeygenClient } from "../../services/heygen-client";
import { PikaClient } from "../../services/pika-client";
import { AppLogger } from "../../services/logger";

export class VideoGenerator {
  constructor(
    private readonly config: AppConfig,
    private readonly ffmpegRenderer: FfmpegRenderer,
    private readonly logger: AppLogger,
    private readonly heygenClient?: HeygenClient,
    private readonly pikaClient?: PikaClient,
  ) {}

  async generate(jobId: string, reelScript: ReelScript): Promise<RenderedReel> {
    if (this.config.video.provider === "heygen" && this.config.heygen.enabled && this.heygenClient) {
      try {
        return await this.generateWithHeygen(jobId, reelScript);
      } catch (error) {
        this.logger.warn(
          {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          },
          "HeyGen generation failed; falling back to FFmpeg text template",
        );
      }
    }

    if (this.config.video.provider === "pika" && this.pikaClient) {
      try {
        return await this.generateWithPika(jobId, reelScript);
      } catch (error) {
        this.logger.warn(
          {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Pika generation failed; trying HeyGen fallback or FFmpeg template",
        );

        if (this.config.heygen.apiKey && this.heygenClient) {
          try {
            return await this.generateWithHeygen(jobId, reelScript);
          } catch (heygenError) {
            this.logger.warn(
              {
                jobId,
                error: heygenError instanceof Error ? heygenError.message : String(heygenError),
              },
              "HeyGen fallback after Pika failure also failed; using FFmpeg text template",
            );
          }
        }
      }
    }

    return this.generateWithTemplate(jobId, reelScript);
  }

  private async generateWithTemplate(jobId: string, reelScript: ReelScript): Promise<RenderedReel> {
    const template = await this.loadTemplate();
    const renderDir = join(this.config.storage.artifactDir, "jobs", jobId, "render");
    await mkdir(renderDir, { recursive: true });

    const timedScenes = this.createTimedScenes(reelScript);
    const templatePath = join(renderDir, "template-background.mp4");
    const videoPath = join(renderDir, "reel.mp4");
    const thumbnailPath = join(renderDir, "cover.jpg");

    await this.ffmpegRenderer.createTemplateBackground(
      templatePath,
      reelScript.totalDurationSec,
      template,
    );
    await this.ffmpegRenderer.renderOverlayVideo(
      templatePath,
      videoPath,
      timedScenes,
      template,
      renderDir,
    );
    await this.ffmpegRenderer.extractThumbnail(videoPath, thumbnailPath);

    return {
      templatePath,
      videoPath,
      thumbnailPath,
      totalDurationSec: reelScript.totalDurationSec,
    };
  }

  private async generateWithHeygen(jobId: string, reelScript: ReelScript): Promise<RenderedReel> {
    const renderDir = join(this.config.storage.artifactDir, "jobs", jobId, "render");
    await mkdir(renderDir, { recursive: true });

    const rawAvatarPath = join(renderDir, "heygen-raw.mp4");
    const videoPath = join(renderDir, "reel.mp4");
    const thumbnailPath = join(renderDir, "cover.jpg");

    const videoId = await this.heygenClient!.generateTalkingAvatarVideo(this.buildNarration(reelScript));
    const completed = await this.heygenClient!.waitForCompletion(videoId);

    await this.heygenClient!.downloadVideo(completed.videoUrl, rawAvatarPath);
    await this.ffmpegRenderer.normalizeVideoForReels(
      rawAvatarPath,
      videoPath,
      this.config.heygen.width,
      this.config.heygen.height,
      this.config.reel.fps,
      {
        topTitle: reelScript.title,
        bottomText: reelScript.ctaText,
        durationSec: reelScript.totalDurationSec,
      },
    );
    await this.ffmpegRenderer.extractThumbnail(videoPath, thumbnailPath);

    return {
      templatePath: rawAvatarPath,
      videoPath,
      thumbnailPath,
      totalDurationSec: reelScript.totalDurationSec,
    };
  }

  private async generateWithPika(jobId: string, reelScript: ReelScript): Promise<RenderedReel> {
    const renderDir = join(this.config.storage.artifactDir, "jobs", jobId, "render");
    await mkdir(renderDir, { recursive: true });

    const rawVideoPath = join(renderDir, "pika-raw.mp4");
    const videoPath = join(renderDir, "reel.mp4");
    const thumbnailPath = join(renderDir, "cover.jpg");

    const prompt = reelScript.aiVideoPrompt || this.buildNarration(reelScript);
    const generated = await this.pikaClient!.generateShortVideo(prompt);
    await this.pikaClient!.downloadVideo(generated.videoUrl, rawVideoPath);

    await this.ffmpegRenderer.normalizeVideoForReels(
      rawVideoPath,
      videoPath,
      this.config.heygen.width,
      this.config.heygen.height,
      this.config.reel.fps,
      {
        topTitle: reelScript.title,
        bottomText: reelScript.ctaText,
        durationSec: reelScript.totalDurationSec,
      },
    );
    await this.ffmpegRenderer.extractThumbnail(videoPath, thumbnailPath);

    return {
      templatePath: rawVideoPath,
      videoPath,
      thumbnailPath,
      totalDurationSec: reelScript.totalDurationSec,
    };
  }

  private async loadTemplate(): Promise<ReelTemplate> {
    const raw = await readFile(this.config.reel.templateFile, "utf8");
    const template = JSON.parse(raw) as ReelTemplate;

    return {
      ...template,
      fps: this.config.reel.fps,
    };
  }

  private createTimedScenes(reelScript: ReelScript): TimedReelScene[] {
    let cursor = 0;

    return reelScript.scenes.map((scene) => {
      const nextScene = {
        ...scene,
        startSec: cursor,
        endSec: cursor + scene.durationSec,
      };

      cursor = nextScene.endSec;
      return nextScene;
    });
  }

  private buildNarration(reelScript: ReelScript): string {
    const chunks = reelScript.scenes.map((scene) => `${scene.title}. ${scene.body}`);
    return chunks.join("\n\n");
  }
}
