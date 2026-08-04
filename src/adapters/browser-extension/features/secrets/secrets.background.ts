import type { Module } from '../../../../kernel/module';
import type { CollectionCommand } from '../../../../kernel/ui-schema';
import { validateSecretRecord, type SecretRecord } from '../../../../shared/secrets';
import { getSecrets, setSecrets } from './secret-store.background';

/**
 * Dashboard-only CRUD panel for docs/ROADMAP.md §11.6's Secret Service — modeled as a Collection
 * Module purely to get the generic Management View/item-form-view.ts renderer and
 * ui/module-data-sources.ts's auto-discovered bus wiring for free (same reuse http-error-mocker's
 * "HTTP Mock & Rewrite" panel already gets), NOT because a script can `needs` this the way a
 * capability-declaring Module can. No `scopes` here and no entry in `kernel/scopes.ts#API_METHODS`
 * — this Module is unreachable from `synapseApi` by construction; the only way a script ever
 * touches a secret is indirectly, through `net.request`'s `{secretRef}` header value
 * (module-registry/net-request-host.ts), gated by the `secrets.use` scope.
 *
 * No module-level active/inactive gate in `run()` (unlike http-error-mocker's): there is no
 * side-effecting registration to tear down, only storage — toggling this Module off in the popup
 * has no effect on secret resolution, which is intentional (the calling script's OWN `secrets.use`
 * grant, plus the secret's own `allowedHost`, are what actually gate use).
 */
export const SecretsModule: Module<CollectionCommand<SecretRecord> | undefined, void> = {
  id: 'secrets',
  label: 'Secrets',
  description:
    'Named values a script references by name (secretRef) but never reads directly — the platform ' +
    'injects the real value into a net.request header at the network boundary. Managed here only: ' +
    'no script-facing API ever creates, edits, lists, or reads one back.',
  needs: ['bus', 'cache'],
  uiSchema: {
    kind: 'collection',
    itemLabel: 'secret',
    idField: 'id',
    fields: [
      { key: 'name', label: 'Name', hint: 'The name a script references as secretRef. Must be unique.', type: 'string', required: true },
      {
        key: 'value',
        label: 'Value',
        hint: 'Stored in plaintext locally, protected by this page being script-unreachable — not by encryption. Leave blank when editing to keep the current value.',
        type: 'secret',
        required: true,
      },
      {
        key: 'allowedHost',
        label: 'Allowed host',
        hint: 'A Chrome match pattern (e.g. https://api.openai.com/*). Only injected into a net.request call whose url falls under this pattern.',
        type: 'string',
        required: true,
      },
    ],
  },
  // Read-side counterpart to the CollectionCommand write path below, same split as
  // http-error-mocker.background.ts's own listCollection.
  listCollection: async () => (await getSecrets()) as unknown as Record<string, unknown>[],
  async run(command, ctx) {
    const cache = ctx.services.cache!;

    if (command?.op === 'upsert') {
      const item = command.item as unknown as Record<string, unknown>;
      const secrets = await getSecrets(cache);
      const index = secrets.findIndex((s) => s.id === item.id);
      const existing = index === -1 ? undefined : secrets[index];
      const now = Date.now();
      // A blank `value` means "keep the current value" (item-form-view.ts never prefills the real
      // secret into the DOM on edit, per its own 'secret' field-type handling) — backfilled here,
      // BEFORE validation, so an intentionally-blank submit never has to be rejected as "empty".
      const candidate = {
        ...item,
        value: item.value || existing?.value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const others = existing ? secrets.filter((s) => s.id !== existing.id) : secrets;
      const result = validateSecretRecord(candidate, others);
      if (!result.valid) throw new Error(`Invalid secret: ${result.reason}`);

      if (index === -1) secrets.push(result.record);
      else secrets[index] = result.record;
      await setSecrets(secrets, cache);
    } else if (command?.op === 'delete') {
      const secrets = await getSecrets(cache);
      await setSecrets(secrets.filter((s) => s.id !== command.id), cache);
    }
  },
};
