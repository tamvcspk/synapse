import { registerDomModule } from './relay';
import { HelloAlertModule } from './modules/hello-alert.module';

registerDomModule(HelloAlertModule);

// One-off smoke-test invocation so loading the extension gives immediate visual
// confirmation that the Kernel foundation + a 'dom' Module wire up correctly.
void HelloAlertModule.run(undefined, { services: {} });
