import { Kernel } from '../../../kernel';
import { ServiceInjector } from '../../../kernel/service-injector';
// import concrete factories once a Module actually declares ai/cache/bus — see kernel-bootstrap skill

const kernel = new Kernel(new ServiceInjector({
  // ai: () => chromeAiAdapter,
  // cache: () => chromeStorageCache,
  // bus: () => chromeRuntimeBus,
}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  kernel.run(/* resolve modules for message.workflowId */ [], message.input)
    .then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});
