import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ReelTemplate, TimedReelScene } from "../../types";
import { wrapText } from "../../utils/strings";
import { AppLogger } from "../logger";

function formatSeconds(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export class FfmpegRenderer {
  constructor(
    private readonly fontFile: string,
    private readonly logger: AppLogger,
  ) {}

  async createTemplateBackground(
    outputPath: string,
    durationSec: number,
    template: ReelTemplate,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });

    const backgroundFilter = [
      `drawbox=x='-220+mod(t*150\\,${template.resolution.width + 440})':y=150:w=420:h=420:color=${template.accentColor}@0.08:t=fill`,
      `drawbox=x='w-260-mod(t*110\\,${template.resolution.width + 320})':y=h-760:w=320:h=320:color=${template.accentColor}@0.12:t=fill`,
      `drawbox=x=54:y=96:w=iw-108:h=ih-192:color=${template.panelColor}@0.40:t=fill`,
      `drawbox=x=54:y=96:w=iw-108:h=ih-192:color=${template.accentColor}@0.14:t=8`,
    ].join(",");

    await this.runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${template.backgroundColor}:s=${template.resolution.width}x${template.resolution.height}:r=${template.fps}:d=${durationSec}`,
      "-vf",
      backgroundFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ]);
  }

  async renderOverlayVideo(
    inputPath: string,
    outputPath: string,
    scenes: TimedReelScene[],
    template: ReelTemplate,
    jobDir: string,
  ): Promise<void> {
    await mkdir(jobDir, { recursive: true });

    const filterParts: string[] = [
      `drawbox=x=72:y=1460:w=iw-144:h=240:color=${template.panelColor}@0.58:t=fill`,
      `drawbox=x=72:y=1460:w=iw-144:h=240:color=${template.accentColor}@0.18:t=5`,
    ];

    const escapedFontFile = this.escapeFilterValue(this.fontFile);

    for (const [index, scene] of scenes.entries()) {
      const titlePath = join(jobDir, `scene-${index + 1}-title.txt`);
      const bodyPath = join(jobDir, `scene-${index + 1}-body.txt`);
      await writeFile(titlePath, wrapText(scene.title.toUpperCase(), 14), "utf8");
      await writeFile(bodyPath, wrapText(scene.body, template.bodyLineWidth), "utf8");

      const start = formatSeconds(scene.startSec);
      const end = formatSeconds(scene.endSec - 0.05);

      filterParts.push(
        `drawtext=fontfile=${escapedFontFile}:textfile=${this.escapeFilterValue(titlePath)}:fontcolor=${template.accentColor}:fontsize=${template.titleFontSize}:x=(w-text_w)/2:y=${template.titleY}:line_spacing=18:enable='between(t,${start},${end})'`,
      );
      filterParts.push(
        `drawtext=fontfile=${escapedFontFile}:textfile=${this.escapeFilterValue(bodyPath)}:fontcolor=${template.textColor}:fontsize=${template.bodyFontSize}:x=${template.safeMargin + 24}:y=${template.bodyY}:line_spacing=18:enable='between(t,${start},${end})'`,
      );
      filterParts.push(
        `drawtext=fontfile=${escapedFontFile}:text='${index + 1}/5':fontcolor=${template.mutedTextColor}:fontsize=38:x=${template.safeMargin + 24}:y=1518:enable='between(t,${start},${end})'`,
      );
    }

    filterParts.push("format=yuv420p");
    const totalDurationSec = scenes.length ? scenes[scenes.length - 1].endSec : 0;

    await this.runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-t",
      formatSeconds(totalDurationSec),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-vf",
      filterParts.join(","),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  }

  async extractThumbnail(inputPath: string, outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });

    await this.runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ]);
  }

  async normalizeVideoForReels(
    inputPath: string,
    outputPath: string,
    width: number,
    height: number,
    fps: number,
    options?: {
      topTitle?: string;
      bottomText?: string;
      durationSec?: number;
    },
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });

    const filterParts = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=18:2,eq=brightness=-0.08:saturation=1.15[bg]`,
      `[0:v]scale=${Math.floor(width * 0.76)}:-2[fg]`,
      "[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]",
      `[v0]drawbox=x=54:y=96:w=${width - 108}:h=${height - 192}:color=white@0.06:t=4[v1]`,
      `[v1]drawbox=x=0:y=0:w=${width}:h=180:color=black@0.26:t=fill[v2]`,
      `[v2]drawbox=x=0:y=${height - 240}:w=${width}:h=240:color=black@0.30:t=fill[v3]`,
    ];

    let currentLabel = "v3";
    if (options?.topTitle) {
      const text = this.escapeFilterValue(options.topTitle.trim().slice(0, 80));
      filterParts.push(
        `[${currentLabel}]drawtext=fontfile=${this.escapeFilterValue(this.fontFile)}:text='${text}':fontcolor=0xF8FAFC:fontsize=56:x=(w-text_w)/2:y=52[v4]`,
      );
      currentLabel = "v4";
    }

    if (options?.bottomText) {
      const text = this.escapeFilterValue(options.bottomText.trim().slice(0, 120));
      filterParts.push(
        `[${currentLabel}]drawtext=fontfile=${this.escapeFilterValue(this.fontFile)}:text='${text}':fontcolor=0xCBD5E1:fontsize=42:x=(w-text_w)/2:y=h-150[v5]`,
      );
      currentLabel = "v5";
    }

    if (options?.durationSec && options.durationSec > 0) {
      const total = formatSeconds(options.durationSec);
      filterParts.push(
        `[${currentLabel}]drawbox=x=80:y=${height - 40}:w='(w-160)*min(max(t/${total}\\,0)\\,1)':h=10:color=0x2DD4BF@0.90:t=fill[v6]`,
      );
      currentLabel = "v6";
    }

    filterParts.push(`[${currentLabel}]format=yuv420p[vout]`);

    await this.runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[vout]",
      "-map",
      "0:a:0",
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  }

  private escapeFilterValue(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .replace(/'/g, "\\'");
  }

  private async runFfmpeg(args: string[]): Promise<void> {
    this.logger.info({ args }, "Executing FFmpeg command");

    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      });
    });
  }
}
