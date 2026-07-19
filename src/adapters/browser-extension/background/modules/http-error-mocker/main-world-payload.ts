import { buildFakeResponseInit, matchMockConfig, type MockConfig } from '../../../../../shared/http-mock';
import { createMainWorldChannel } from '../../../utils/main-world/event-channel';
import { installNetworkInterceptor, type InterceptDecision } from '../../../utils/main-world/network-interceptor';
import { MOCK_CONFIG_CHANNEL_ID } from './constants';

/**
 * MAIN-world composition root for http-error-mocker — owned by the Module (colocated in its
 * folder) even though it's a separate build entry, per the main-world-interceptor skill. This is
 * where business logic (matchMockConfig/buildFakeResponseInit, from the Global SDK) gets wired
 * into the generic infra (installNetworkInterceptor, createMainWorldChannel). Zero chrome.* here —
 * dynamically registered by background/modules/http-error-mocker/index.ts via
 * utils/main-world-injector.ts, built via the `?script&module` resource import.
 */
let configs: MockConfig[] = [];

createMainWorldChannel<MockConfig[]>(MOCK_CONFIG_CHANNEL_ID).onUpdate((next) => {
  configs = next ?? [];
});

installNetworkInterceptor(({ method, url }): InterceptDecision => {
  const match = matchMockConfig(configs, url, method);
  if (!match) return { intercept: false };

  const fake = buildFakeResponseInit(match);
  return {
    intercept: true,
    response: {
      status: fake.status,
      statusText: fake.statusText,
      bodyText: fake.bodyText,
      ...(match.delayMs !== undefined ? { delayMs: match.delayMs } : {}),
    },
  };
});
