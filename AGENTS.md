# Agent guidelines

Guardrails for AI coding agents (Claude Code, Codex, etc.) working in this repo. Human contributors are welcome to follow them too.

## Language

- **All committed text is in English.** Code, comments, identifiers, docs (`README.md`, anything under `docs/`), commit messages, PR titles/descriptions, error messages, log lines, UI strings.
- Chat with the user in whatever language they prefer — that does not change what lands in files.

## Code style

- Formatter is Prettier with the repo's `.prettierrc.json`: tabs (width 4), single quotes, no semicolons, trailing commas, 100-char line, arrow parens always.
- **Always run `npm run format` after editing any code, JSON, YAML, or Markdown** — even if you think the change matches the style. CI fails if `npm run lint` finds drift, and prior agents have repeatedly forgotten this. Treat it as the last step before reporting a task complete.
- Indentation is **tabs** even in JSON/YAML/Markdown (see `.editorconfig`).
- TypeScript is ESM with explicit `.ts` extensions in relative imports (e.g. `import { foo } from './bar.ts'`).

## Project shape

- npm workspaces: `shared/`, `household/`, `household/web/`, `member/`. Don't reach across without going through `shared/` for cross-cutting types.
- Dev workflow: `npm run dev` (Household + Vite); see [README.md](README.md) for the full quick start.
- Env files (`.env.household`, `.env.member`) are loaded automatically by the dev scripts via Node's `--env-file-if-exists`. Don't reintroduce inline env-var prefixes in npm scripts.
- Single source of truth for design and milestones is [plan.md](plan.md).

## Protocol changes

The Household ↔ Member wire protocol is versioned via semver `PROTOCOL_VERSION` in [shared/src/protocol.ts](shared/src/protocol.ts). When you touch protocol types or `PROTOCOL_VERSION`, pick the right level — Household rejects different majors, warns on different minors, ignores patches (see [README.md](README.md#protocol-versioning)).

- **Patch** — change in `shared/` that doesn't alter the wire format (refactor, helper, comment).
- **Minor** — purely additive: new optional field, new message type, new enum value the peer can ignore. Both old and new peers must still interoperate.
- **Major** — anything else: removing/renaming/retyping a field, making an optional field required, changing semantics of an existing field, removing a message type.

When in doubt, bump major. Silent breakage from a too-small bump is worse than an extra reject during deploy.

When you add or change a message type/field, update both the TypeScript types in [shared/src/protocol.ts](shared/src/protocol.ts) **and** the runtime schemas in [shared/src/protocol.schema.ts](shared/src/protocol.schema.ts) — the types are for code that produces messages, the schemas validate everything that comes off the wire. A field that exists in the type but not the schema gets silently dropped; the other way around throws on every connection. After every bump add an entry to [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Things to avoid

- Adding documentation files unless the user asks. Update `README.md`.
- New dependencies without weighing them against a stdlib / existing-package solution.
- Bypassing safety checks: no `--no-verify`, no force-push to `main`, no rewriting published commits.
