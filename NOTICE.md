# NOTICE

This project (`@leo000001/claude-code-mcp`) is licensed under the MIT License (see `LICENSE`).

## Third-party components

This project depends on third-party packages. Their licenses and terms may impose additional
requirements on redistribution and use.

### Direct dependencies (resolved versions from `package-lock.json`)

- `@anthropic-ai/claude-agent-sdk@0.3.220` — license is declared as “SEE LICENSE IN README.md” in the package metadata. This package bundles a Claude Code CLI; please review Anthropic's documentation and legal terms referenced by that project before redistributing or deploying.
- `@anthropic-ai/sdk@0.115.0` — MIT License
- `@modelcontextprotocol/sdk@1.30.0` — MIT License
- `zod@4.3.6` — MIT License

For a complete dependency graph, see `package-lock.json`. When installed, each dependency’s
license information is included with the package itself (typically under its `LICENSE` file or
`package.json` fields).

### Optional native dependencies

Claude Agent SDK `0.3.220` selects one platform-specific optional package such as
`@anthropic-ai/claude-agent-sdk-darwin-arm64`. These packages contain the prebuilt Claude
executable and declare their license as “SEE LICENSE IN LICENSE.md”.

If you redistribute this project (or produce bundled artifacts), you are responsible for ensuring
you comply with any applicable third-party license obligations and include required notices.
