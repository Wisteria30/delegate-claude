# Contributing

Thanks for your interest in contributing to delegate-claude!

## Getting Started

```bash
git clone https://github.com/Wisteria30/delegate-claude.git
cd delegate-claude
mise install
mise exec -- task install
```

### Local Environment Requirements

- mise
- Node.js 22.23.1 and Task 3.52.0 (installed from `mise.toml`)
- npm (bundled with the pinned Node.js version)
- Windows contributors: install **Git for Windows** (`bash.exe`) for Claude Code CLI compatibility
- Optional: set `CLAUDE_CODE_GIT_BASH_PATH` explicitly when testing MCP clients launched outside your terminal environment

## Development Workflow

1. Create a feature branch from the default branch
2. Make your changes
3. Ensure all checks pass:
   ```bash
   mise exec -- task ci
   ```
4. Commit your changes (the pre-commit hook runs the staged-file, type, and unit-test checks through Task)
5. Open a Pull Request against the default branch

## Code Style

- TypeScript strict mode
- Prettier for formatting (auto-applied via pre-commit hook)
- ESLint for linting
- Prefer explicit types over `any` where possible

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation (README, docs/DESIGN.md) if the public API changes
- Ensure CI passes before requesting review

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Release Checklist

1. Update `CHANGELOG.md` with the upcoming version and confirm `package.json` reflects that version.
2. Run `mise exec -- task ci` to prove the working tree passes the canonical quality gate.
3. Verify the generated `dist/` contains the expected entry points.
4. Refresh any documentation (README/CONTRIBUTING/docs) that describe public behavior or APIs touched by the release.
5. Ensure `NOTICE.md` lists the third-party components bundled in the release and contains links or pointers to their licenses.
6. Double-check `files`, `bin`, and other package metadata so the published package only ships the intended assets.
