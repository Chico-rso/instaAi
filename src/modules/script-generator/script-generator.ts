import { RawTelegramPost, ReelSceneKey, ReelScript, StructuredTelegramContent } from "../../types";
import { normalizeHashtag, truncate } from "../../utils/strings";
import { GlmClient } from "../../services/ai-client/glm-client";
import { AppLogger } from "../../services/logger";

interface RawReelScriptPayload {
  title?: string;
  subtitle?: string;
  visualNotes?: string;
  hashtags?: string[];
  scenes?: Array<{
    key?: ReelSceneKey;
    title?: string;
    body?: string;
  }>;
}

const orderedSceneKeys: ReelSceneKey[] = ["hook", "problem", "prompt", "result", "cta"];
const sceneDurations: Record<ReelSceneKey, number> = {
  hook: 3,
  problem: 4,
  prompt: 6,
  result: 5,
  cta: 3,
};

export class ScriptGenerator {
  constructor(
    private readonly glmClient: GlmClient,
    private readonly logger: AppLogger,
  ) {}

  async generate(
    post: RawTelegramPost,
  ): Promise<{ structuredContent: StructuredTelegramContent; reelScript: ReelScript }> {
    const structuredContent = await this.normalizePost(post);
    const reelScript = await this.buildReelScript(structuredContent);

    return {
      structuredContent,
      reelScript,
    };
  }

  private async normalizePost(post: RawTelegramPost): Promise<StructuredTelegramContent> {
    const fallback = this.fallbackStructuredContent(post);

    try {
      const aiResult = await this.glmClient.completeJson<{
        hook: string;
        explanation: string;
        prompt: string;
        exampleResult: string;
      }>(
        [
          {
            role: "system",
            content:
              "Extract structured fields from a Telegram post about AI prompts. Return strict JSON only with keys hook, explanation, prompt, exampleResult. Preserve the source meaning and do not invent product claims.",
          },
          {
            role: "user",
            content: `Telegram post:\n${post.text}`,
          },
        ],
        0.2,
      );

      return {
        sourcePostId: post.id,
        rawText: post.text,
        hook: truncate((aiResult.hook || fallback.hook).trim(), 140),
        explanation: truncate((aiResult.explanation || fallback.explanation).trim(), 260),
        prompt: truncate((aiResult.prompt || fallback.prompt).trim(), 340),
        exampleResult: truncate((aiResult.exampleResult || fallback.exampleResult).trim(), 260),
      };
    } catch (error) {
      this.logger.warn(
        {
          postId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic Telegram parsing",
      );
      return fallback;
    }
  }

  private async buildReelScript(structuredContent: StructuredTelegramContent): Promise<ReelScript> {
    const fallback = this.fallbackReelScript(structuredContent);

    try {
      const payload = await this.glmClient.completeJson<RawReelScriptPayload>(
        [
          {
            role: "system",
            content:
              "You are a short-form video editor. Convert AI educational content into a concise Instagram Reels script. Return JSON only with keys title, subtitle, visualNotes, hashtags, scenes. scenes must contain exactly five objects with keys hook, problem, prompt, result, cta. Keep each body punchy and readable on screen.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                source: structuredContent,
                constraints: {
                  format: ["hook", "problem", "prompt", "result", "cta"],
                  ctaText: "Full prompts in Telegram",
                  maxBodyLength: 120,
                },
              },
              null,
              2,
            ),
          },
        ],
        0.5,
      );

      return this.sanitizeReelScript(payload, fallback);
    } catch (error) {
      this.logger.warn(
        {
          sourcePostId: structuredContent.sourcePostId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic Reel script",
      );
      return fallback;
    }
  }

  private fallbackStructuredContent(post: RawTelegramPost): StructuredTelegramContent {
    const lines = post.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const sections: Partial<Record<keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText">, string[]>> = {};
    let activeKey: keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText"> | undefined;

    for (const line of lines) {
      const match = /^(hook|explanation|prompt|example result|result|example)\s*[:\-]?\s*(.*)$/i.exec(line);
      if (match) {
        const key = this.normalizeSectionKey(match[1]);
        activeKey = key;
        sections[key] = [];
        if (match[2]) {
          sections[key]?.push(match[2].trim());
        }
        continue;
      }

      if (activeKey) {
        sections[activeKey]?.push(line);
      }
    }

    const paragraphs = post.text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      sourcePostId: post.id,
      rawText: post.text,
      hook: truncate(sections.hook?.join(" ") || paragraphs[0] || lines[0] || "AI workflow that stops blank-page syndrome.", 140),
      explanation: truncate(
        sections.explanation?.join(" ") || paragraphs[1] || paragraphs[0] || post.text,
        260,
      ),
      prompt: truncate(
        sections.prompt?.join(" ") ||
          paragraphs.find((paragraph) => /prompt/i.test(paragraph)) ||
          post.text,
        340,
      ),
      exampleResult: truncate(
        sections.exampleResult?.join(" ") || paragraphs.at(-1) || paragraphs[0] || post.text,
        260,
      ),
    };
  }

  private fallbackReelScript(structuredContent: StructuredTelegramContent): ReelScript {
    const scenes = [
      {
        key: "hook" as const,
        title: "Hook",
        body: truncate(structuredContent.hook, 120),
        durationSec: sceneDurations.hook,
      },
      {
        key: "problem" as const,
        title: "Problem",
        body: truncate(structuredContent.explanation, 120),
        durationSec: sceneDurations.problem,
      },
      {
        key: "prompt" as const,
        title: "Prompt",
        body: truncate(structuredContent.prompt, 170),
        durationSec: sceneDurations.prompt,
      },
      {
        key: "result" as const,
        title: "Result",
        body: truncate(structuredContent.exampleResult, 120),
        durationSec: sceneDurations.result,
      },
      {
        key: "cta" as const,
        title: "CTA",
        body: "Full prompts in Telegram",
        durationSec: sceneDurations.cta,
      },
    ];

    return {
      title: truncate(structuredContent.hook, 80),
      subtitle: "AI prompt breakdown for Instagram Reels",
      ctaText: "Full prompts in Telegram",
      visualNotes: "Minimal high-contrast motion background with crisp typography.",
      hashtags: ["#ai", "#automation", "#promptengineering", "#contentsystem", "#instagramreels"],
      totalDurationSec: scenes.reduce((total, scene) => total + scene.durationSec, 0),
      scenes,
    };
  }

  private sanitizeReelScript(
    payload: RawReelScriptPayload,
    fallback: ReelScript,
  ): ReelScript {
    const incomingScenes = new Map<
      ReelSceneKey,
      {
        key?: ReelSceneKey;
        title?: string;
        body?: string;
      }
    >();

    for (const scene of payload.scenes ?? []) {
      if (scene.key) {
        incomingScenes.set(scene.key, scene);
      }
    }

    const scenes = orderedSceneKeys.map((key) => {
      const scene = incomingScenes.get(key);
      const fallbackScene = fallback.scenes.find((item) => item.key === key)!;

      return {
        key,
        title: truncate((scene?.title || fallbackScene.title).trim(), 30),
        body: truncate(
          (scene?.body || fallbackScene.body).replace(/\s+/g, " ").trim() || fallbackScene.body,
          key === "prompt" ? 170 : 120,
        ),
        durationSec: sceneDurations[key],
      };
    });

    const hashtags = (payload.hashtags ?? fallback.hashtags)
      .map(normalizeHashtag)
      .filter(Boolean)
      .slice(0, 6);

    return {
      title: truncate((payload.title || fallback.title).trim(), 80),
      subtitle: truncate((payload.subtitle || fallback.subtitle).trim(), 110),
      ctaText: "Full prompts in Telegram",
      visualNotes: truncate((payload.visualNotes || fallback.visualNotes).trim(), 180),
      hashtags: hashtags.length ? hashtags : fallback.hashtags,
      totalDurationSec: scenes.reduce((total, scene) => total + scene.durationSec, 0),
      scenes,
    };
  }

  private normalizeSectionKey(
    value: string,
  ): keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText"> {
    if (/example result|result|example/i.test(value)) {
      return "exampleResult";
    }

    if (/hook/i.test(value)) {
      return "hook";
    }

    if (/prompt/i.test(value)) {
      return "prompt";
    }

    return "explanation";
  }
}
