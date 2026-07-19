import type { Module } from '../../../../kernel/module';

/** Smoke-test Module for the Kernel foundation: pops an alert to confirm the pipeline runs. */
export const HelloAlertModule: Module<void, void> = {
  id: 'hello-alert',
  needs: ['dom'],
  supportedEnvs: ['browser-extension'],
  async run() {
    alert("hello, I'm testing module");
  },
};
