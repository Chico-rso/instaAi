import { CaptionPayload, RawTelegramPost, ReelScript, StructuredTelegramContent } from "../../types";
import { normalizeHashtag, truncate } from "../../utils/strings";
import { GlmClient } from "../../services/ai-client/glm-client";
import { AppLogger } from "../../services/logger";

interface CaptionResponse {
  caption?: string;
  hashtags?: string[];
  firstComment?: string;
}

const defaultCaptionHashtags = [
  "#reels",
  "#viral",
  "#ai",
  "#pov",
  "#cinematic",
];

export class CaptionGenerator {
  constructor(
    private readonly glmClient: GlmClient,
    private readonly logger: AppLogger,
  ) {}

  async generate(
    post: RawTelegramPost,
    structuredContent: StructuredTelegramContent,
    reelScript: ReelScript,
  ): Promise<CaptionPayload> {
    const fallback = this.fallbackCaption(post, structuredContent, reelScript);

    try {
      const response = await this.glmClient.completeJson<CaptionResponse>(
        [
          {
            role: "system",
            content:
              [
                "Write Instagram Reels captions for short viral videos.",
                "Return JSON only with keys caption, hashtags, firstComment.",
                "Use reelScript as the single source of truth.",
                "Caption format: 2-4 short lines, hook in first line, concise and curiosity-driven.",
                "Hashtags: return 5-7 relevant hashtags.",
                "Avoid mentioning HeyGen, avatar testing, render diagnostics, or clickbait promises.",
              ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                reelScript,
                sourcePermalink: post.permalink,
              },
              null,
              2,
            ),
          },
        ],
        0.6,
      );

      const hashtags = ensureHashtags(
        normalizeHashtagList(response.hashtags, fallback.hashtags),
        fallback.hashtags,
      );

      return {
        caption: formatCaption(response.caption || fallback.caption),
        hashtags,
        firstComment: response.firstComment?.trim() || fallback.firstComment,
      };
    } catch (error) {
      this.logger.warn(
        {
          sourcePostId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic caption",
      );
      return fallback;
    }
  }

  private fallbackCaption(
    post: RawTelegramPost,
    _structuredContent: StructuredTelegramContent,
    reelScript: ReelScript,
  ): CaptionPayload {
    const hook = reelScript.scenes.find((scene) => scene.key === "hook")?.body || reelScript.title;
    const twist = reelScript.scenes.find((scene) => scene.key === "twist")?.body || reelScript.idea;

    const lines = [
      truncate(`POV: ${reelScript.idea}`, 180),
      truncate(hook, 180),
      truncate(`Twist: ${twist}`, 220),
      "Full prompts in Telegram.",
    ];

    const firstComment = post.permalink ? `Source post: ${post.permalink}` : undefined;

    return {
      caption: lines.join("\n\n"),
      hashtags: ensureHashtags(
        reelScript.hashtags.length
          ? reelScript.hashtags
          : ["#ai", "#reels", "#viral", "#pov", "#contentcreator"],
        defaultCaptionHashtags,
      ),
      firstComment,
    };
  }
}

function normalizeHashtagList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}

function formatCaption(value: string): string {
  const cleaned = value.replace(/\n{3,}/g, "\n\n").trim();
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!lines.length) {
    return "";
  }

  const firstLine = truncate(lines[0], 96);
  const rest = lines.slice(1).join("\n");
  return truncate([firstLine, rest].filter(Boolean).join("\n\n"), 2_100);
}

function ensureHashtags(candidate: string[], fallback: string[]): string[] {
  const merged = [...candidate, ...fallback, ...defaultCaptionHashtags]
    .map(normalizeHashtag)
    .filter(Boolean);

  const unique: string[] = [];
  for (const tag of merged) {
    if (!unique.includes(tag)) {
      unique.push(tag);
    }
  }

  return unique.slice(0, 7);
}
