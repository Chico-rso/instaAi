import { ProxyAgent, setGlobalDispatcher } from "undici";

import { AppLogger } from "./logger";

let isConfigured = false;

export function configureHttpClient(proxyUrl: string | undefined, logger: AppLogger): void {
  if (isConfigured) {
    return;
  }

  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    logger.info({ proxyUrl }, "Configured global HTTP proxy");
  }

  isConfigured = true;
}
