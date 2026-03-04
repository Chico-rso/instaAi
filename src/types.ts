export interface RawTelegramPost {
  id: string;
  messageId: number;
  channel: string;
  text: string;
  date: string;
  permalink?: string;
}

export interface StructuredTelegramContent {
  sourcePostId: string;
  rawText: string;
  hook: string;
  explanation: string;
  prompt: string;
  exampleResult: string;
}

export type ReelSceneKey = "hook" | "problem" | "prompt" | "result" | "cta";

export interface ReelScene {
  key: ReelSceneKey;
  title: string;
  body: string;
  durationSec: number;
}

export interface ReelScript {
  title: string;
  subtitle: string;
  ctaText: string;
  visualNotes: string;
  hashtags: string[];
  totalDurationSec: number;
  scenes: ReelScene[];
}

export interface TimedReelScene extends ReelScene {
  startSec: number;
  endSec: number;
}

export interface CaptionPayload {
  caption: string;
  hashtags: string[];
  firstComment?: string;
}

export interface RenderedReel {
  templatePath: string;
  videoPath: string;
  thumbnailPath: string;
  totalDurationSec: number;
}

export interface StoredAsset {
  kind: "local" | "s3";
  key: string;
  localPath: string;
  publicUrl?: string;
}

export type JobStatus = "running" | "completed" | "failed" | "skipped";

export interface JobRecord {
  id: string;
  trigger: "cron" | "manual" | "webhook";
  status: JobStatus;
  createdAt: string;
  completedAt?: string;
  sourcePostId?: string;
  skipReason?: string;
  error?: string;
  reelVideoUrl?: string;
  reelThumbnailUrl?: string;
  instagramMediaId?: string;
  instagramContainerId?: string;
  captionPreview?: string;
}

export interface InstagramAuthSession {
  accessToken: string;
  tokenType?: string;
  expiresAt?: string;
  issuedAt: string;
  scopes: string[];
  user: {
    id: string;
    username?: string;
    accountType?: string;
    name?: string;
  };
  raw?: Record<string, unknown>;
}

export interface ReelTemplate {
  name: string;
  resolution: {
    width: number;
    height: number;
  };
  fps: number;
  backgroundColor: string;
  panelColor: string;
  accentColor: string;
  textColor: string;
  mutedTextColor: string;
  safeMargin: number;
  titleFontSize: number;
  bodyFontSize: number;
  titleY: number;
  bodyY: number;
  bodyLineWidth: number;
}
