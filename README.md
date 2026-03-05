# Instagram Reels Automation

Production-oriented Node.js + TypeScript service that turns Telegram AI posts into Instagram Reels:

`Telegram channel post -> GLM-5 viral script -> Pika/FFmpeg render -> caption -> Telegram delivery and/or Instagram publish`

## What It Does

- Reads the latest Telegram channel post through the Telegram Bot API.
- Normalizes the post into structured content: `hook`, `explanation`, `prompt`, `example result`.
- Converts that content into a short viral Reel script with structure: `hook -> setup -> escalation -> twist`.
- Renders a 1080x1920 MP4 using selectable providers:
  - `pika` (Fal queue API model)
  - `template` (FFmpeg text-overlay fallback)
- Creates an Instagram caption with hashtags.
- Sends the generated Reel to Telegram (video + caption) for manual Instagram upload workflow.
- Generates a text-to-video prompt (`aiVideoPrompt`) for Pika.
- Automatic fallback to FFmpeg template mode if external video provider fails.
- Publishes the final Reel through the Instagram Graph API.
- Supports cron-based scheduling, retries, structured logging, webhook ingestion, and a manual trigger endpoint.

## Architecture

```text
src
  /modules
    /script-generator
    /video-generator
    /caption-generator
    /instagram-publisher
  /services
    /telegram-reader
    /ffmpeg-renderer
    /ai-client
    /storage
  /config
  index.ts
```

## Assumptions

- Telegram access is implemented through the Bot API.
- The bot must be an admin in the source channel so it can receive `channel_post` updates.
- `TELEGRAM_CHANNEL` can be either `@channel_username` or the numeric channel chat id.
- Instagram publishing requires a professional account with Graph API content publishing access.
- Instagram must be able to fetch the rendered video from a public URL.
- In `local` storage mode, that means the service itself must be reachable at `PUBLIC_BASE_URL`.
- In `s3` mode, the uploaded object must be publicly reachable through `S3_PUBLIC_BASE_URL`.

## Project Structure

```text
.
├── Dockerfile
├── README.md
├── package.json
├── templates
│   └── reel-default-template.json
├── tsconfig.json
└── src
    ├── config
    │   └── env.ts
    ├── index.ts
    ├── modules
    │   ├── caption-generator
    │   │   └── caption-generator.ts
    │   ├── instagram-publisher
    │   │   └── instagram-publisher.ts
    │   ├── script-generator
    │   │   └── script-generator.ts
    │   └── video-generator
    │       └── video-generator.ts
    ├── services
    │   ├── ai-client
    │   │   └── glm-client.ts
    │   ├── ffmpeg-renderer
    │   │   └── ffmpeg-renderer.ts
    │   ├── job-state-store.ts
    │   ├── json-file-store.ts
    │   ├── logger.ts
    │   ├── pipeline-orchestrator.ts
    │   ├── retry.ts
    │   ├── storage
    │   │   └── storage-service.ts
    │   └── telegram-reader
    │       └── telegram-reader.ts
    ├── types.ts
    └── utils
        └── strings.ts
```

## Environment Variables

Copy `.env.example` to `.env` and fill the required values.

### Required

```env
GLM_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL=
PUBLIC_BASE_URL=https://your-domain.example
```

### Core Runtime

```env
PORT=3000
LOG_LEVEL=info
SCHEDULER_ENABLED=true
CRON_SCHEDULE=0 */4 * * *
TIMEZONE=Europe/Moscow
MANUAL_TRIGGER_TOKEN=
APP_BASE_PATH=
OUTBOUND_PROXY_URL=
```

### Telegram

```env
TELEGRAM_MODE=polling
TELEGRAM_WEBHOOK_SECRET=
PROCESS_ON_WEBHOOK=false
TELEGRAM_DELIVERY_ENABLED=true
TELEGRAM_DELIVERY_CHAT_ID=
TELEGRAM_DELIVERY_DISABLE_NOTIFICATION=false
```

- `TELEGRAM_DELIVERY_CHAT_ID` is optional; if empty, the bot sends to `TELEGRAM_CHANNEL`.

### GLM-5

```env
GLM_API_BASE_URL=https://api.z.ai/api/paas/v4
GLM_MODEL=glm-5
```

### Instagram

```env
INSTAGRAM_ENABLED=true
INSTAGRAM_API_VERSION=v24.0
INSTAGRAM_SHARE_TO_FEED=true
INSTAGRAM_ACCESS_TOKEN=
IG_USER_ID=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_AUTH_MODE=instagram-login
INSTAGRAM_REDIRECT_URI=
INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_content_publish
```

- Set `INSTAGRAM_ENABLED=false` to use Telegram-only delivery mode.

### Video Provider

```env
VIDEO_PROVIDER=template
```

- `template`: default FFmpeg text-overlay rendering.
- `pika`: text-to-video mode via Fal queue API (`PIKA_API_KEY` required).

### Pika (Fal Queue API)

```env
PIKA_API_KEY=
PIKA_BASE_URL=https://queue.fal.run
PIKA_MODEL=fal-ai/pika/v2.2/text-to-video
PIKA_ASPECT_RATIO=9:16
PIKA_DURATION_SEC=10
PIKA_NEGATIVE_PROMPT=
PIKA_POLL_INTERVAL_MS=5000
PIKA_POLL_TIMEOUT_MS=480000
```

### Storage

```env
STORAGE_DRIVER=local
ARTIFACT_DIR=./data/artifacts
STATE_DIR=./data/state
PUBLIC_BASE_URL=https://your-domain.example
```

### S3-Compatible Storage

```env
STORAGE_DRIVER=s3
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=insta-ai-reels
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://cdn.example.com/insta-ai-reels
```

## End-to-End Flow

1. `telegram-reader` fetches the newest channel post.
2. `script-generator` extracts `hook`, `explanation`, `prompt`, and `example result`.
3. `script-generator` turns that data into a viral short Reel:
   - Hook
   - Setup
   - Escalation
   - Twist + CTA: `Full prompts in Telegram`
4. `video-generator` builds a render plan and selects provider by `VIDEO_PROVIDER`.
5. `ffmpeg-renderer` either overlays template text scenes or normalizes provider output for Reels.
6. `caption-generator` creates the Instagram caption.
7. `storage-service` saves the video and exposes a public URL.
8. `instagram-publisher` creates a media container and publishes the Reel.

## Reel Format

- Resolution: `1080x1920`
- Aspect ratio: `9:16`
- Output: `MP4`
- Scenes:
  - `Hook` for 2 seconds
  - `Setup` for 2 seconds
  - `Escalation` for 3 seconds
  - `Twist` for 3 seconds

## API Endpoints

### Health Check

```bash
curl http://localhost:3000/health
```

### Manual Trigger

```bash
curl -X POST http://localhost:3000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  -d '{"force":true}'
```

### Job Status

```bash
curl http://localhost:3000/api/jobs/<job-id> \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN"
```

### Telegram Webhook

```bash
curl -X POST http://localhost:3000/api/telegram/webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d @update.json
```

## Running Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Provide environment variables

```bash
cp .env.example .env
```

### 3. Start in development mode

```bash
npm run dev
```

### 4. Build production bundle

```bash
npm run build
```

### 5. Start production bundle

```bash
npm start
```

## Running With Docker

```bash
docker build -t insta-ai-reels .
docker run --rm -p 3000:3000 --env-file .env insta-ai-reels
```

## Operational Notes

- Rendered files are archived under `data/artifacts/archive/<job-id>`.
- Local public assets are served from `data/artifacts/public/<job-id>`.
- Pipeline state is persisted in `data/state/pipeline-state.json`.
- If a Telegram post was already processed, scheduled runs skip it unless `force=true`.
- The webhook endpoint can ingest updates without immediately rendering, which is useful when cron remains the scheduling source of truth.

## Production Checklist

- Put the service behind HTTPS.
- Set `PUBLIC_BASE_URL` to the public origin that serves `/assets/*`.
- Add the Telegram bot to the channel as admin.
- Configure the Instagram app, token, and permissions for publishing.
- Mount persistent volumes for `data/artifacts` and `data/state`.
- Rotate tokens and move them into a real secret manager.
- Add CI to run `npm install`, `npm run build`, and smoke tests in a container with FFmpeg installed.

## Known Gaps

- The service assumes Telegram Bot API access to the source channel instead of scraping public channel pages.
- No queue worker is included yet; concurrent runs are prevented in-process with a lock.
- No test suite is included in this initial scaffold because the workspace started empty.
