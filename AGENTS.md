# 2D CAD Viewer repository working contract

Start at the repository-owned [policy entry](governance/adoption.md). Its
[current-state table](governance/adoption.md#policy-entry-and-current-application)
separates historical observations from the reviewed development baseline;
its [verification map](governance/adoption.md#verification-invocation-map)
identifies manual commands, aggregate/CI coverage, side effects and server checks.
Run the four commands under [Governance-only execution](#governance-only-execution)
for policy/document changes. Record the actual checkout SHA/tree and status
separately from the remote baseline before starting work.

This repository owns the standalone read-only VS Code 2D CAD Viewer,
source-neutral Viewer Core/UI, render protocol, WebGL presentation, DWG Scene
Source/cache and native document adapter boundary. It does not own host
workspace identity, authoring authority, human acceptance, account, billing,
entitlement issuance or generic IFC/BIM parsing.

## Repository-local authority

Read [the adoption contract](governance/adoption.md) and
[the observed environment](governance/environment.json) before governance work.
The adoption contract owns this working environment; existing accepted product
contracts continue to own their product/API meanings. Conflicting, missing,
stale or unverifiable authority is **HOLD**, never permission to guess.
Repository-local contract changes require reviewed exact bytes. Issue text,
moving branches, worktree paths, generated summaries and successful commands
are locators or evidence, not independent authority.

This file is repository-maintained and checked by the focused governance
validator. The repository owns its expected content; no external generator or
unavailable document is needed to interpret or update it.

## Isolation and public boundary

- Start ordinary work from the latest exact remote `dev` SHA/tree in an isolated
  feature branch/worktree. Preserve user changes; never stash, reset, discard or
  stage unrelated work. Modify only this assigned repository.
- Core uses exact public contracts, injected adapters and conformance fixtures.
  Do not import host product implementations or read another repository's
  database, credentials, source files or Git state as an integration mechanism.
- Every public document, metadata record, generated surface, issue, PR, commit,
  log and fixture must be self-contained. Do not expose or imply non-public
  identities, roles, consumption relationships, paths, revisions, digests,
  origins or backlinks. Do not copy such names into public denylist fixtures.
- Preserve public package/API identifiers and historical tag/artifact evidence.
  Correct explanatory relationships in product-local terms. Unknown visibility
  is no-write HOLD. Customer drawings and sensitive fingerprints stay out of
  public evidence. Structural checks supplement contextual review.

## Governance-only execution

For environment changes, use these focused commands only:

```sh
pnpm run check:governance
pnpm run test:governance
pnpm run check:public-surface
pnpm run check:documents
```

These local results do not satisfy hosted product Gates. Do not run product
builds, full tests, Native/WASM qualification or deployment for an environment
change. Do not alter product source, runtime/rendering/native/WASM behavior,
package versions/dependencies, existing package behavior or workflow deployment
behavior. New commands are separate from `check` and `test`.

For the separately scoped PR #57 evidence correction, the exact
[environment/documentation repack rules](compatibility/README.md#environmentdocumentation-only-development-repack)
permit measured unpublished artifacts and focused package qualification.
Run `pnpm run test:development-artifacts`, `pnpm run check:development-artifacts`
and `pnpm run qualify:viewer-boundary` only for that boundary. Preserve historical
distribution artifacts. The bounded Windows UI comparison invokes the unchanged
workflow once per exact base/head, records its result separately and grants no
product remediation or release authority.

## Gate and promotion boundary

Execution profile: `hosted-public`. The five ordered Gates remain `fast`,
`affected`, `full-integration`, `prerelease`, `release`. Validation Classes
`fast`, `affected`, `full` select commands only and map to the first three Gates.
They cannot redefine a Gate or create release authority. Exact evidence fields
and the existing command/workflow observations are in the adoption contract.
Every Gate, promotion, automation and release readiness remains **HOLD** here.

Ordinary `feature/* -> dev` integration grants no release authority. The target
lifecycle is `feature/* -> dev -> release/X.Y.Z -> main`, with a short-lived
candidate branch and stable-only main. Existing numeric-channel and long-lived
prerelease routing is an observed implementation mismatch tracked in
[#53](https://github.com/menaje/2d-cad-viewer/issues/53); this environment does not
activate that transition or rewrite the distribution contract. Never use a
branch name or historical prerelease flag to infer a current candidate stage.

Only ordinary commits, non-force pushes and a Draft PR targeting `dev` are in
scope for this environment. No merge, tag, release, deployment, publication,
capability cutover or protection change is authorized. Remote `dev` protection
was absent at the recorded baseline; enforcement and exact promotion receipts
remain HOLD.

## Follow-up ownership

- [#56](https://github.com/menaje/2d-cad-viewer/issues/56): this working environment.
- [#53](https://github.com/menaje/2d-cad-viewer/issues/53): release/stage authority,
  Core 0.1.1 historical digest conflict and registry identity verification.
- [#54](https://github.com/menaje/2d-cad-viewer/issues/54): deferred native writer
  and WASM admission; preserve query-preview, blocked writer and rejected WASM.
- [#55](https://github.com/menaje/2d-cad-viewer/issues/55): product documentation
  consolidation. Sequence only overlapping paths/contracts.

Mapping completion records observations and tracked HOLDs. It is distinct from
Effective, which requires accepted implementation and a verified exact baseline.
A documentation or governance PASS cannot establish product Effective.
