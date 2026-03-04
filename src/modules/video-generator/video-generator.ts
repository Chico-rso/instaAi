import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig } from "../../config/env";
import { ReelScript, ReelTemplate, RenderedReel, TimedReelScene } from "../../types";
import { FfmpegRenderer } from "../../services/ffmpeg-renderer/ffmpeg-renderer";

export class VideoGenerator {
  constructor(
    private readonly config: AppConfig,
    private readonly ffmpegRenderer: FfmpegRenderer,
  ) {}

  async generate(jobId: string, reelScript: ReelScript): Promise<RenderedReel> {
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
}
