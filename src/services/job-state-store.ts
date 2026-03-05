import { join } from "node:path";

import { JobRecord, RawTelegramPost } from "../types";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store";

interface PipelineState {
  telegramCursor?: number;
  latestTelegramPost?: RawTelegramPost;
  processedTelegramPostIds: Record<string, string>;
  jobs: Record<string, JobRecord>;
}

const defaultState: PipelineState = {
  processedTelegramPostIds: {},
  jobs: {},
};

export class JobStateStore {
  private statePath: string;

  private state?: PipelineState;

  constructor(stateDir: string) {
    this.statePath = join(stateDir, "pipeline-state.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.state) {
      this.state = await readJsonFile<PipelineState>(this.statePath, defaultState);
      this.state.processedTelegramPostIds ??= {};
      this.state.jobs ??= {};
    }
  }

  private async persist(): Promise<void> {
    await this.ensureLoaded();
    await writeJsonFileAtomic(this.statePath, this.state);
  }

  async getTelegramCursor(): Promise<number | undefined> {
    await this.ensureLoaded();
    return this.state?.telegramCursor;
  }

  async setTelegramCursor(cursor: number): Promise<void> {
    await this.ensureLoaded();
    if (!this.state) {
      return;
    }

    this.state.telegramCursor = cursor;
    await this.persist();
  }

  async getLatestTelegramPost(): Promise<RawTelegramPost | undefined> {
    await this.ensureLoaded();
    return this.state?.latestTelegramPost;
  }

  async setLatestTelegramPost(post: RawTelegramPost): Promise<void> {
    await this.ensureLoaded();
    if (!this.state) {
      return;
    }

    const current = this.state.latestTelegramPost;
    if (!current || post.messageId >= current.messageId) {
      this.state.latestTelegramPost = post;
      await this.persist();
    }
  }

  async hasProcessedTelegramPost(postId: string): Promise<boolean> {
    await this.ensureLoaded();
    return Boolean(this.state?.processedTelegramPostIds[postId]);
  }

  async markTelegramPostProcessed(postId: string, jobId: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.state) {
      return;
    }

    this.state.processedTelegramPostIds[postId] = jobId;
    await this.persist();
  }

  async createJob(job: JobRecord): Promise<void> {
    await this.ensureLoaded();
    if (!this.state) {
      return;
    }

    this.state.jobs[job.id] = job;
    await this.persist();
  }

  async updateJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
    await this.ensureLoaded();
    if (!this.state?.jobs[jobId]) {
      return undefined;
    }

    const nextJob = {
      ...this.state.jobs[jobId],
      ...patch,
    };

    this.state.jobs[jobId] = nextJob;
    await this.persist();
    return nextJob;
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    await this.ensureLoaded();
    return this.state?.jobs[jobId];
  }

  async getGeneratedReelsCountForMonth(monthKey: string): Promise<number> {
    await this.ensureLoaded();
    const jobs = this.state?.jobs ? Object.values(this.state.jobs) : [];

    return jobs.reduce((total, job) => {
      if (job.status !== "completed" || !job.completedAt?.startsWith(monthKey)) {
        return total;
      }

      if (typeof job.processedCount === "number") {
        return total + Math.max(0, job.processedCount);
      }

      return total + (job.sourcePostId ? 1 : 0);
    }, 0);
  }
}
