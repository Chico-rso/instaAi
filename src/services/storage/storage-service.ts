import { createReadStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { AppConfig } from "../../config/env";
import { StoredAsset } from "../../types";
import { AppLogger } from "../logger";
import { writeJsonFileAtomic } from "../json-file-store";

export class StorageService {
  private s3Client?: S3Client;

  constructor(
    private readonly config: AppConfig["storage"],
    private readonly logger: AppLogger,
  ) {
    if (this.config.driver === "s3" && this.config.s3) {
      this.s3Client = new S3Client({
        region: this.config.s3.region,
        endpoint: this.config.s3.endpoint,
        forcePathStyle: this.config.s3.forcePathStyle,
        credentials: {
          accessKeyId: this.config.s3.accessKeyId,
          secretAccessKey: this.config.s3.secretAccessKey,
        },
      });
    }
  }

  getPublicAssetsRoot(): string {
    return join(this.config.artifactDir, "public");
  }

  async persistPublicAsset(
    jobId: string,
    sourcePath: string,
    fileName: string,
    contentType: string,
  ): Promise<StoredAsset> {
    const archiveDir = join(this.config.artifactDir, "archive", jobId);
    const archivePath = join(archiveDir, fileName);
    await mkdir(archiveDir, { recursive: true });
    await copyFile(sourcePath, archivePath);

    if (this.config.driver === "local") {
      const publicDir = join(this.config.artifactDir, "public", jobId);
      const publicPath = join(publicDir, fileName);
      await mkdir(publicDir, { recursive: true });
      await copyFile(sourcePath, publicPath);

      return {
        kind: "local",
        key: `${jobId}/${fileName}`,
        localPath: publicPath,
        publicUrl: this.config.publicBaseUrl
          ? new URL(`assets/${jobId}/${fileName}`, ensureTrailingSlash(this.config.publicBaseUrl)).toString()
          : undefined,
      };
    }

    if (!this.s3Client || !this.config.s3) {
      throw new Error("S3 storage is not configured.");
    }

    const key = `${jobId}/${fileName}`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: key,
        Body: createReadStream(archivePath),
        ContentType: contentType,
      }),
    );

    const publicUrl = `${this.config.s3.publicBaseUrl.replace(/\/$/, "")}/${key}`;
    this.logger.info({ key, publicUrl }, "Uploaded public asset");

    return {
      kind: "s3",
      key,
      localPath: archivePath,
      publicUrl,
    };
  }

  async writeJobMetadata(jobId: string, fileName: string, data: unknown): Promise<void> {
    const targetPath = join(this.config.artifactDir, "archive", jobId, fileName);
    await writeJsonFileAtomic(targetPath, data);
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
