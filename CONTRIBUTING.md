# Contributing to Emily AgentOS

Thanks for taking the time to improve Emily AgentOS. This project aims to stay local-first, auditable, and practical for real agent workflows, so contributions should preserve those properties.

## Development Branch

Use `dev` for active development:

```bash
git checkout dev
git pull --ff-only origin dev
git checkout -b your-change-name
```

`master` is treated as the stable install branch. Changes should normally land in `dev` first.

## Local Setup

Requirements:

- Node.js `>=22.18`
- npm
- git

Install dependencies:

```bash
npm install
```

Run the TUI from source:

```bash
npm run tui
```

Run model setup:

```bash
node src/index.ts model
```

## Pull Request Guidelines

Please keep pull requests focused and easy to review.

Good pull requests usually include:

- a clear description of the problem and solution;
- tests for behavior changes;
- README or `user-guide.md` updates for user-facing behavior;
- screenshots or terminal output snippets for TUI changes when useful;
- notes about any migration, security, or compatibility implications.

Avoid:

- committing `.emily/` runtime state, local databases, logs, or secrets;
- broad formatting changes mixed with behavior changes;
- replacing established local patterns without explaining why;
- adding new dependencies when a small local implementation is enough;
- storing raw API keys in provider config.

## Verification

For small UI or model-configuration changes, run the focused checks:

```bash
npm run typecheck
node test/ui.test.ts
node test/model-config.test.ts
```

For routing or chat behavior changes, also run:

```bash
node test/chat-routing.test.ts
node test/planner-calibration.test.ts
```

For runtime, storage, provider, planning, security, or command changes, run:

```bash
npm run check
```

Optional integration checks:

```bash
EMILY_VECTOR_INTEGRATION=true npm run check
EMILY_PROVIDER_INTEGRATION=true npm run check
```

## Coding Standards

- Prefer TypeScript that works with Node.js native type stripping.
- Keep runtime behavior deterministic in tests.
- Keep provider secrets in environment variables and config references such as `apiKeyEnv`.
- Respect permission modes and tool approval boundaries.
- Keep comments short and useful.
- Use existing registries, adapters, and command patterns before adding new abstractions.

## TUI Changes

The TUI should stay compact and terminal-native.

- Preserve the transcript/composer flow: `❯` for user input, `┊` for assistant/progress, `·` for metadata.
- Avoid large separators inside normal chat flow.
- Make loading states visible only while work is happening.
- Test with a real terminal when the change affects cursor movement, line clearing, or wrapping.

## Community Standards

Be respectful, constructive, and specific. Assume good intent, but prioritize user safety and maintainability when discussing tradeoffs. Harassment, personal attacks, or disclosure of private credentials are not acceptable in project spaces.

