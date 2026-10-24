# Agent Guidelines

## General Policy
- **No Direct Push**: Never run `git push`. Always ask the maintainer to push.
- **Human Review Required**: Pause and request review after implementation; commit only after explicit approval.
- **No Speculation**: Never guess missing specs, knobs, or business logic. Pause and ask when in doubt.
- **Scope Boundary**: Stay strictly focused on in-repo code, specs, and architecture. Refuse off-topic requests.
- **Frontend Only**: Work only on this repo's frontend. Do not implement or modify FastGPT, its workflows, or its knowledge base.
- **Destructive Operations**: Pause and wait for explicit permission before performing any negative or destructive operation (e.g., deletions, force overwrites, history rewrites, service disruption).
- **Discuss Before Doing**: Do not start hands-on work immediately after receiving information or a request. The default mode is discussion only — analyze, propose approaches, and ask questions first. Only begin implementation after the user has explicitly agreed to the plan or to a specific action.
- **Ask When Unsure**: When encountering anything unclear, ambiguous, or unfamiliar — specs, requirements, code behavior, tooling, etc. — do NOT default to executing or guessing. Pause, ask clarifying questions, and explain your understanding or reasoning so the user can confirm or correct before any action is taken. Prefer over-asking over over-assuming.
- **Plain Language**: In project documents and when talking to the user, use words a person can understand without insider slang or coined jargon, such as 「xx门」 ("xx-gate"), 「xx电池」 ("xx battery"), or 「入史」 ("make history"). Layout and content must be easy to read. If a specialized term is necessary, use it at most once or twice and make the meaning clear.

## Environment & Tooling
- **No Stack Until Named**: Do not initialize a project, add dependencies, or pick a framework, package manager, or directory layout until the user names them.
- **No Secrets in the Client**: Never put API keys, tokens, or `.env` values in frontend code or commits. Do not call FastGPT directly from browser code. Do not prefix FastGPT variables with `VITE_`. Vite copies `VITE_` variables into the browser bundle.
- **No Invented Contract**: Do not invent Base URL, appId, `variables`, auth, or endpoints. Stop and ask when they are missing.

## Code Style
- **Semicolons Required**: In TypeScript (`.ts` and `.tsx`), end every statement with a semicolon. Do not omit semicolons. End type and interface members with a semicolon as well. Use a comma only where the syntax requires a separator, such as object and array literals, parameter lists, import and export specifiers, and enum members. This rule must NOT be skipped.

## Git & Commits
- **History Preservation**: Never rewrite pushed or non-HEAD git history. Make new commits instead.
- **Remote Blocks Force Push**: Remote Restrict Deletions and Block Force Pushes stay on. Before push, fix with a new commit, `git revert`, or `git commit-tree`. After push, do not force-push; ask the maintainer if those rules must be lifted.
- **No Secret Commits**: Never stage `.env` or credential files.
- **One Change, One Commit**: One logical change maps to one commit. Keep related files together; do not split one change thinly or mix unrelated changes.

## Verification
- **Lint Before Done**: After any TypeScript or React change, run `pnpm lint` before declaring the work complete. This command includes type-aware rules. `pnpm build` still runs `tsc --noEmit` separately.
- **Browser Before Done**: After any UI, layout, routing, or client-state change, verify the affected flow in the browser before declaring it complete. If browser tools are unavailable, say what was not verified.
