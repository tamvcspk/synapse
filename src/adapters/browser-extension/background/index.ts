import { Kernel } from '../../../kernel';
import type { Module } from '../../../kernel/module';
import { ServiceInjector } from '../../../kernel/service-injector';
import { resolveWorkflowSteps, type Workflow } from '../../../kernel/workflow';
import { registerRpcHandler } from '../module-registry/rpc-handler';
// import concrete factories once a Module actually declares ai/cache/bus — see kernel-bootstrap skill

const injector = new ServiceInjector({
  // ai: () => chromeAiAdapter,
  // cache: () => chromeStorageCache,
  // bus: () => chromeRuntimeBus,
});
const kernel = new Kernel(injector);

registerRpcHandler(injector);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  kernel.run(/* resolve modules for message.workflowId */ [], message.input, (failure) => {
    console.error(`Synapse: module "${failure.moduleId}" failed`, failure.error);
  }).then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});

// Lets uploaded modules (chrome.userScripts, USER_SCRIPT world) reach the background via
// chrome.runtime.sendMessage — throws if the user hasn't enabled "Allow User Scripts" for this
// extension in chrome://extensions, so this must not crash the service worker on failure.
chrome.userScripts.configureWorld({ messaging: true }).catch((err) => {
  console.warn('Synapse: chrome.userScripts.configureWorld failed — enable "Allow User Scripts" for this extension in chrome://extensions to use uploaded modules.', err);
});

// Smoke-test for Workflow (kernel/workflow.ts): 'append-a' sorts before 'append-b' alphabetically,
// but the Workflow explicitly orders b-then-a — proving execution order comes from Workflow.steps,
// never from module-discovery/glob iteration order (see bundled-modules.ts).
const demoModules: Module<string, string>[] = [
  { id: 'append-a', needs: [], async run(input) { return `${input} A`; } },
  { id: 'append-b', needs: [], async run(input) { return `${input} B`; } },
];
const demoWorkflow: Workflow = { id: 'demo-chain', steps: ['append-b', 'append-a'] };
const demoResolution = resolveWorkflowSteps(demoWorkflow, (id) => demoModules.find((m) => m.id === id));
if (demoResolution.missing.length === 0) {
  kernel.run(demoResolution.modules, 'start').then((result) => {
    console.log('Synapse: workflow demo ->', result); // expected "start B A"
  });
}
