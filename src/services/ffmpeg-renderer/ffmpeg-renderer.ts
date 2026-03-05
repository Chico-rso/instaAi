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

    await this.runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      filterParts.join(","),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
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
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });

    const scaleAndPadFilter = [
      `scale='if(gt(a,${width}/${height}),${width},-2)':'if(gt(a,${width}/${height}),-2,${height})'`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "format=yuv420p",
    ].join(",");

    await this.runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      scaleAndPadFilter,
      "-r",
      String(fps),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
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
