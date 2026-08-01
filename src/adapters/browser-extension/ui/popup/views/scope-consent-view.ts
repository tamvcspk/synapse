import van from 'vanjs-core';
import { SCOPE_CATALOG, consentLineFor } from '../../../../../kernel/scopes';
import type { SynapseScopeGrant } from '../../../../../kernel/synapse-api';

const { div, p, small, ul, li, button, strong } = van.tags;

/**
 * In-flow scope-consent view, replacing the native <dialog> version — see action-result-view.ts's
 * header comment for why this popup never uses <dialog>.
 *
 * **Enforced and Disclosed are rendered as two separate lists, never one** (docs/ROADMAP.md §11.3
 * constraint C). Denying a Disclosed scope protects nobody: a script running on the page already
 * shares its DOM and can call `document.querySelector` with zero permission from Synapse. Showing
 * it in the same list as a real gate, under the same Allow/Deny, is a consent UI that lies about
 * what refusal buys — and the whole permission model rests on not lying to the user.
 */
export interface ScopeConsentViewProps {
  moduleId: string;
  moduleLabel?: string;
  scopes: SynapseScopeGrant[];
}

export interface ScopeConsentViewCallbacks {
  onApprove(): void;
  onDeny(): void;
}

export function renderScopeConsentView(
  root: HTMLElement,
  props: ScopeConsentViewProps,
  callbacks: ScopeConsentViewCallbacks,
): void {
  root.replaceChildren();

  const enforced = props.scopes.filter((g) => SCOPE_CATALOG[g.scope].enforcement === 'enforced');
  const disclosed = props.scopes.filter((g) => SCOPE_CATALOG[g.scope].enforcement === 'disclosed');

  van.add(
    root,
    div(
      p(strong(props.moduleLabel ?? props.moduleId), ' requests:'),

      enforced.length > 0
        ? div(
            p(small('Will be blocked if you deny:')),
            ul(...enforced.map((grant) => li(consentLineFor(grant), scopeTag(grant.scope)))),
          )
        : null,

      disclosed.length > 0
        ? div(
            p(small('The script can do this anyway — listed so you know:')),
            ul(
              { class: 'scope-disclosed' },
              ...disclosed.map((grant) => li(consentLineFor(grant), scopeTag(grant.scope))),
            ),
          )
        : null,

      props.scopes.length === 0 ? p(small('No permissions requested.')) : null,

      div(
        { class: 'form-actions' },
        button({ type: 'button', class: 'secondary', onclick: callbacks.onDeny }, 'Deny'),
        button({ type: 'button', onclick: callbacks.onApprove }, 'Allow'),
      ),
    ),
  );
}

/** The raw scope name, hover-explained from the catalog — the consent line is written for a human,
 * but this is a technical audience that will want the identifier it maps to (docs/ROADMAP.md §11). */
function scopeTag(scope: SynapseScopeGrant['scope']) {
  return small({ class: 'scope-tag', title: SCOPE_CATALOG[scope].description }, ` (${scope})`);
}
