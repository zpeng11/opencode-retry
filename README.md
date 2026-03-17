# OpenCode Plugin Starter

This repository is a minimal baseline for building an OpenCode plugin package with TypeScript. It keeps the parts that matter from `/home/eleven/opencode/packages/plugin` and `/home/eleven/opencode/packages/web/src/content/docs/plugins.mdx`: author from `src/`, build to `dist/`, ship a dist-first package, and keep the starter free of plugin-specific behavior until the real plugin contract is known.

## Why this shape

- Single-package root instead of a monorepo, because the current repo only needs one publishable plugin package.
- ESM-first output, which matches how OpenCode loads plugin modules.
- Plain `tsc` for build, watch, and typecheck so the same scripts work with both `npm` and `bun`.
- Placeholder package identity with `private: true`, so you can choose the final package name, license, and publish settings later.

## Layout

```text
.
├── src/
│   └── index.ts
├── scripts/
│   └── clean.mjs
├── bunfig.toml
├── package.json
├── README.md
└── tsconfig.json
```

## Scripts

`npm` flow:

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```

`bun` flow:

```bash
bun install
bun run typecheck
bun run build
bun pm pack
```

## Package notes

- Change `name`, `version`, `license`, and `private` before you publish.
- `@opencode-ai/plugin` is in `devDependencies` because the starter uses type-only imports.
- If you start importing runtime helpers such as `tool` from `@opencode-ai/plugin`, move that package to `dependencies`.
- Keep new public API surface re-exported from `src/index.ts`; do not add wildcard exports until the plugin contract stabilizes.

## What is intentionally not here

- No extra subpath exports yet.
- No test harness or playground yet.
- No publish rewrite step like the OpenCode monorepo uses.

Those can be added later once the plugin behavior is real enough to justify them.
