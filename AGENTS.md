# 2D CAD Viewer repository agent contract

<!-- Deterministically projected. Do not hand-edit generated copies. -->

## Canonical references and precedence

- This root AGENTS.md is the repository-local public operating contract. Adopted repository documents and versioned public contracts precede summaries; linked worktrees, moving branches and issue text are not authority.
- Execution uses the closed profiles and ordered Gates mapped below. Repository commands and workflows provide evidence but cannot create authority for an unmerged or different revision.

Conflicting, missing, stale or unverifiable authority is `HOLD`. A lower
instruction layer may be stricter but cannot weaken a higher accepted boundary.

## Owns

- Source-neutral Viewer Core/UI, render protocol, WebGL presentation, DWG Scene Cache/native adapter and standalone viewer products.

## Does Not Own

- Consumer-specific workspace, canonical authoring identity, human acceptance, account, billing or entitlement issuance.
- Generic IFC/BIM source parsing and exploration.

## Authority and dependency prohibitions

- Do not import consumer product implementations into Viewer Core; use exact versioned public contracts, injected adapters and conformance fixtures.
- Do not read private databases, credentials, source files or Git state as an integration mechanism.

## Security and visibility boundary

- Keep public issues, documents, workflows, logs and evidence self-contained for this repository and free of non-public identities, paths, revisions, relationships and source data.
- Customer drawings, credentials and sensitive fingerprints never enter commits or public evidence.

## Migration and legacy boundary

- Protocol/cache changes require an exact version, compatibility window, valid/invalid fixtures and rollback behavior.
- A package or adapter migration does not transfer consumer authority or release authority.

## Execution profile and five Gates

Execution profile: `hosted-public`.

| Gate | Repository commands | Workflow | Required executor | Evidence mapping | Current readiness |
| --- | --- | --- | --- | --- | --- |
| `fast` | `pnpm run check:documents`<br>`pnpm run check:release-channel` | `.github/workflows/ci.yml` | `hosted` | `input-digest`, `command-set-digest`, `execution-provenance`, `result` | `HOLD` |
| `affected` | `pnpm run test:viewer-contracts` | `.github/workflows/ci.yml` | `hosted` | `affected-paths`, `affected-contracts`, `command-set-digest`, `execution-provenance`, `result` | `HOLD` |
| `full-integration` | `pnpm check` | `.github/workflows/ci.yml` | `hosted` | `repository-wide-command-set`, `generated-drift-check`, `execution-provenance`, `result` | `HOLD` |
| `prerelease` | `pnpm install --frozen-lockfile`<br>`pnpm check` | `.github/workflows/release-route.yml` | `hosted` | `candidate-provenance`, `environment-provenance`, `execution-provenance`, `result` | `HOLD` |
| `release` | `pnpm install --frozen-lockfile`<br>`pnpm check` | `.github/workflows/release.yml` | `hosted` | `release-artifact-provenance`, `release-readiness`, `execution-provenance`, `result` | `HOLD` |

The Gate identifiers and order are closed. `PASS`, `FAIL` and `HOLD`
apply only to exact inputs and evidence; a command success on another revision
does not create promotion or release authority.

## Branch readiness and promotion constraints

- Ordinary work uses dev; only reviewed dev-to-prerelease and prerelease-to-main exact merged heads may become candidates for authority.
- The unprotected dev branch and missing exact promotion receipt keep remote protection and promotion readiness HOLD.

Remote protection observation: `HOLD`
— The public dev branch is not protected; prerelease/main protection does not make the full lifecycle enforced.

Promotion readiness: `HOLD`.

## Generated-artifact ownership and drift

The deterministic projection generator owns expected AGENTS bytes; drift or public-boundary leakage fails validation.
