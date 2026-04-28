# Agent guidelines

Guardrails for AI coding agents (Claude Code, Codex, etc.) working in this repo. Human contributors are welcome to follow them too.

## Language

- **All committed text is in English.** Code, comments, identifiers, docs (`README.md`, anything under `docs/`), commit messages, PR titles/descriptions, error messages, log lines, UI strings.
- Chat with the user in whatever language they prefer — that does not change what lands in files.

## Code style

- Formatter is Prettier with the repo's `.prettierrc.json`: tabs (width 4), single quotes, no semicolons, trailing commas, 100-char line, arrow parens always.
- Run `npm run format` before committing if unsure; CI runs `npm run lint`.
- Indentation is **tabs** even in JSON/YAML/Markdown (see `.editorconfig`).
- TypeScript is ESM with explicit `.ts` extensions in relative imports (e.g. `import { foo } from './bar.ts'`).

## Project shape

- npm workspaces: `shared/`, `household/`, `household/web/`, `member/`. Don't reach across without going through `shared/` for cross-cutting types.
- Dev workflow: `npm run dev` (Household + Vite); see [README.md](README.md) for the full quick start.
- Env files (`.env.household`, `.env.member`) are loaded automatically by the dev scripts via Node's `--env-file-if-exists`. Don't reintroduce inline env-var prefixes in npm scripts.
- Single source of truth for design and milestones is [plan.md](plan.md).

## Things to avoid

- Adding documentation files unless the user asks. Update `README.md`.
- New dependencies without weighing them against a stdlib / existing-package solution.
- Bypassing safety checks: no `--no-verify`, no force-push to `main`, no rewriting published commits.
