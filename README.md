# T3 Code

T3 Code is a minimal web GUI for coding agents.

The current product direction is:

- use one OpenAI-compatible core LLM endpoint as the default app model/runtime backend
- allow users to connect and log in with both Codex and Claude providers
- keep Codex and Claude login/account flows stubbed in the UI until the full provider onboarding flow is finished

## Installation

> [!WARNING]
> T3 Code is in an early transition period.
>
> The planned default is a single OpenAI-compatible core LLM configuration
> supplied by the operator. Codex and Claude should still be exposed as
> user-connectable providers, but the in-product login flow may be stubbed while
> onboarding and account management are being built out.
>
> For local/manual setup today:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)
Roadmap and milestones: [docs/product-roadmap.md](./docs/product-roadmap.md)
Deployments: [docs/deployments.md](./docs/deployments.md)
Scripting with the SDK: [packages/sdk/README.md](./packages/sdk/README.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
