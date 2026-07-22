import { Kernel } from '../../../kernel';
import type { Module } from '../../../kernel/module';
import { ServiceInjector } from '../../../kernel/service-injector';
import { resolveWorkflowSteps, type Workflow } from '../../../kernel/workflow';
import { createCompositeModule } from '../../../kernel/composite-module';
import { registerRpcHandler } from '../module-registry/rpc-handler';
import { BACKGROUND_MODULES } from '../module-registry/background-modules';
import { setUserScriptsPermissionGranted } from '../module-registry/storage';
import { chromeRuntimeBus } from './services/bus';
import { chromeStorageCache } from './services/cache';
// import a concrete ai factory once a Module actually declares it — see kernel-bootstrap skill

const injector = new ServiceInjector({
  // ai: () => chromeAiAdapter,
  cache: () => chromeStorageCache,
  bus: () => chromeRuntimeBus,
});
const kernel = new Kernel(injector);

registerRpcHandler(injector);

// Registers every background/modules/*/index.ts Module onto the Bus (needs: ['bus']) or runs it
// once (pipeline). A bus-only Module never gets an initial call from kernel.run() itself — it's
// only registered as a listener — so http-error-mocker also needs an explicit startup 'sync' so
// configs left active from a previous session resume being registered after a service-worker
// restart. Awaited (not fire-and-forget) so the 'sync' emit below is guaranteed to run after bus
// registration has actually happened, rather than relying on Kernel.run's internal ordering.
void kernel
  .run(BACKGROUND_MODULES, undefined, (failure) => {
    console.error(`Synapse: background module "${failure.moduleId}" failed`, failure.error);
  })
  .then(() => {
    chromeRuntimeBus.emit('http-error-mocker', { op: 'sync' });
  });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  kernel.run(/* resolve modules for message.workflowId */ [], message.input, (failure) => {
    console.error(`Synapse: module "${failure.moduleId}" failed`, failure.error);
  }).then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});

// Lets uploaded modules (chrome.userScripts, USER_SCRIPT world) reach the background via
// chrome.runtime.sendMessage — throws if the user hasn't enabled "Allow User Scripts" for this
// extension in chrome://extensions, so this must not crash the service worker on failure. The
// result is persisted (not just logged) so the popup can surface it — see storage.ts and
// popup/main.ts. When "Allow User Scripts" has never been granted, `chrome.userScripts` itself is
// `undefined` (not just a rejecting call) — a bare `.then()/.catch()` chain doesn't cover that,
// since the property access throws synchronously before either ever attaches. An uncaught throw
// during a service worker's top-level evaluation fails the *entire* registration (Chrome status
// code 15), discarding every listener in this file — hence the outer try/catch.
try {
  chrome.userScripts.configureWorld({ messaging: true })
    .then(() => setUserScriptsPermissionGranted(true))
    .catch((err) => {
      console.warn('Synapse: chrome.userScripts.configureWorld failed — enable "Allow User Scripts" for this extension in chrome://extensions to use uploaded modules.', err);
      void setUserScriptsPermissionGranted(false);
    });
} catch (err) {
  console.warn('Synapse: chrome.userScripts is unavailable — enable "Allow User Scripts" for this extension in chrome://extensions to use uploaded modules.', err);
  void setUserScriptsPermissionGranted(false);
}

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

// Smoke-test for Composite Module (kernel/composite-module.ts, docs/ROADMAP.md #3): proves
// createCompositeModule's own sequential dispatch + bypass logic, reusing the same demoModules
// above rather than registering a fake business Module into the Registry. `getSubState` stands in
// for RegistryEntry.subState — a real Composite Module instance wires this to the chrome.storage
// read the Adapter already has (see chrome-module-registry.ts's getSubStateMap).
let demoBypassAppendB = false;
const demoComposite = createCompositeModule({
  id: 'demo-composite',
  subModules: demoModules,
  getSubState: async () => (demoBypassAppendB ? { 'append-b': false } : {}),
  onSubFailure: (failure) => console.error(`Synapse: composite demo step "${failure.moduleId}" failed`, failure.error),
});
kernel
  .run([demoComposite], 'start')
  .then((result) => {
    console.log('Synapse: composite demo (no bypass) ->', result); // expected "start A B"
    demoBypassAppendB = true;
    return kernel.run([demoComposite], 'start');
  })
  .then((result) => {
    console.log('Synapse: composite demo (append-b bypassed) ->', result); // expected "start A"
  });
