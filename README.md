# Synapse

**Personal automation & AI playground, built as a Manifest V3 browser extension.**

Synapse is a minimalist framework for building modular tasks and agents that scale in complexity only as needed. Simple tasks (data fetching, processing) require zero AI/agentic overhead—complex tasks can leverage AI, event buses, and caching by explicitly declaring what they need.

## Main Purpose

Synapse enables you to:

- **Write simple, single-purpose tasks** (e.g., crawl & chunk documentation, fetch data, transform content) as lightweight pure functions—no agentic machinery required.
- **Scale gradually to complex AI workflows** (decision engines, multi-step agents, RAG) by adding capability declarations, without refactoring the core.
- **Experiment with personal automation** (browser-based) using a clean, extensible architecture (Hexagonal Design).
- **Avoid vendor lock-in** through an adapter-based runtime model: add support for VS Code, Electron, or Node later without rewriting your modules or core.

### Architecture Highlights

- **Kernel:** A minimal, AI-agnostic core that resolves module manifests, injects services, and coordinates execution.
- **Modules:** The smallest unit of work. Declare what you need (`needs: ['net', 'ai', 'cache']`), and the Kernel provisions only those services.
- **Progressive Complexity:** Each module's infrastructure overhead matches its declared capabilities, not a global default.
- **Hexagonal Architecture:** Core + Ports/Services (abstract interfaces) + Adapters (concrete implementations). Currently, only the browser extension adapter is implemented.

See [docs/design.md](docs/design.md) for full technical specification.

---

## ⚠️ Disclaimer

**DO NOT use Synapse in production or for illegal/unauthorized activities.**

- **Experimental software:** This is a personal playground. Expect breaking changes, unfinished features, and minimal stability guarantees.
- **No production readiness:** Not tested at scale, not hardened against security threats, not designed for multi-user or cloud deployment.
- **Illegal activities prohibited:** Synapse must not be used for:
  - Unauthorized automation of websites or services (violates terms of service).
  - Credential theft, phishing, or social engineering.
  - Scraping protected data or circumventing access controls.
  - Interference with computer systems or networks.
  - Any activity that violates local, regional, or international law.
  - Impersonation, harassment, or malicious activity.

**You are responsible for all use of this software.** Ensure your automation complies with applicable laws, terms of service, and ethical guidelines before deploying.

---

## Setup & Development

### Prerequisites

- **Node.js 18+** (LTS recommended)
- **npm 9+**
- **A Chromium-based browser** (Chrome, Edge, Brave, etc.) for testing the extension locally

### Installation

1. **Clone or download the repository:**
   ```bash
   git clone <repository-url>
   cd synapse
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Type-check the code (optional but recommended):**
   ```bash
   npm run typecheck
   ```

### Development Workflow

#### Start the Dev Server

```bash
npm run dev
```

This launches the Vite dev server with hot reload enabled. The bundled extension is output to `dist/browser-extension/`.

#### Load the Extension in Your Browser

**Chrome/Edge/Brave:**

1. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`, etc.).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `dist/browser-extension/` folder from this repository.
5. The extension should now appear in your extensions list and toolbar.

**Hot reload during development:**
- Edit any TypeScript file in `src/`.
- Vite automatically rebuilds; refresh the extension in the browser or toggle it off/on to see changes.

### Build for Production

```bash
npm run build
```

This bundles the extension optimized for production and outputs to `dist/browser-extension/`.

**Next steps after building:**
- Test thoroughly in your browser.
- Do **not** distribute or deploy without reviewing the Disclaimer section above.

### Project Structure

```
src/
  kernel/                          # Core (platform-agnostic)
    index.ts
    module.ts                      # Module contract, Service interfaces
    service-injector.ts
    scheduler.ts
    environment-guard.ts
  modules/                         # Portable modules (no DOM access)
  adapters/
    browser-extension/             # Browser Extension Adapter
      background/index.ts          # Kernel bootstrap (runs in service worker)
      content-scripts/
        index.ts
        relay.ts                   # Messaging bridge
        modules/
          hello-alert.module.ts    # Example content-script module
docs/
  design.md                        # Full technical specification
dist/                              # Build output (ignored in git)
```

### Configuration Files

- **`tsconfig.json`** – TypeScript compiler options (strict mode enabled).
- **`vite.config.ts`** – Vite bundler config with `@crxjs/vite-plugin` for MV3 extension support.
- **`manifest.config.ts`** – Browser extension manifest (Manifest V3).

---

## Creating Your First Module

### Simple Module (No AI, No Bus)

A module that fetches data:

```typescript
// src/modules/my-fetcher.module.ts
import { Module } from '../kernel/module';

export const MyFetcher: Module = {
  id: 'my-fetcher',
  needs: ['net'],  // Only networking capability
  run(input: { url: string }) {
    const response = await fetch(input.url);
    return response.json();
  },
};
```

### Complex Module (With AI & Bus)

A module that uses AI:

```typescript
// src/modules/my-ai-agent.module.ts
import { Module } from '../kernel/module';

export const MyAiAgent: Module = {
  id: 'my-ai-agent',
  needs: ['ai', 'cache', 'bus'],  // Declare what you need
  run(input, ctx) {
    if (isSimple(input)) {
      return applyRuleLogic(input);
    }
    // AI is lazily initialized by the Kernel
    return ctx.services.ai.ask({
      prompt: `Process: ${JSON.stringify(input)}`,
    });
  },
};
```

See [docs/design.md](docs/design.md) for more examples and full API documentation.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Vite dev server with hot reload |
| `npm run dev:browser` | Alias for `npm run dev` |
| `npm run build` | Build the extension for production |
| `npm run build:browser` | Alias for `npm run build` |
| `npm run typecheck` | Run TypeScript type checking (no emit) |

---

## Troubleshooting

**Extension doesn't load:**
- Ensure `dist/browser-extension/` exists and contains `manifest.json`.
- Try refreshing the extension or reloading it in `chrome://extensions/`.
- Check the browser console (DevTools) for errors.

**Hot reload isn't working:**
- Kill the Vite dev server and restart with `npm run dev`.
- Manually refresh the extension page in `chrome://extensions/`.

**Type errors during build:**
- Run `npm run typecheck` to see all TypeScript errors.
- Fix issues in your code and rebuild.

**Module not executing:**
- Check the Kernel logs in the background service worker console (`chrome://extensions/` → Details → Inspect views → background page).
- Ensure your module is registered in the Kernel bootstrap (see `src/adapters/browser-extension/background/index.ts`).
- Verify the module's `needs[]` declaration matches its actual dependencies.

---

## Next Steps

1. **Read [docs/design.md](docs/design.md)** for the full architectural vision and technical spec.
2. **Review [src/adapters/browser-extension/](src/adapters/browser-extension/)** to understand how the extension loads.
3. **Create a module** using the examples above; start simple, add capabilities as needed.
4. **Test locally** using the browser's DevTools (see Development Workflow).

---

## License

This project is provided as-is for personal use. Respect the Disclaimer above and all applicable laws.

**Questions or feedback?** Review [docs/design.md](docs/design.md) or open an issue.
