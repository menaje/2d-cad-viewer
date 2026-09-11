---
{"schemaVersion":"1.1.0","documentId":"VIEWER-GOVERNANCE-ADOPTION","title":"Viewer Repository-local Architecture Adoption Environment","type":"contract","version":"1.0.0","status":"draft","normativity":"normative","authority":["viewer-governance-work-environment"],"visibility":"public","supersedes":[],"lastReviewed":"2026-09-08","effectiveAt":"2026-09-08","extensions":{"repository":"viewer","documentRole":"working-environment-contract"}}
---

# Repository-local architecture adoption environment

This contract is self-contained for `menaje/2d-cad-viewer`. It governs the work
environment and observed governance inventory, not product functionality or
release execution. Its draft is reviewable through [#56](https://github.com/menaje/2d-cad-viewer/issues/56).
The catalog date is a document metadata date, not a product Effective receipt.
Root [AGENTS.md](../AGENTS.md) summarizes these working rules.

## Policy entry and current application

Read this contract for work-environment requirements, follow the owner index
below for concrete product rules, use [AGENTS](../AGENTS.md) for task instructions,
and bind validation evidence to the exact changed input. This navigation adds no
new product policy or release authority.

| State | Exact observation / locator | Meaning |
| --- | --- | --- |
| Historical inventory baseline | [environment.json](environment.json) `baseline`: commit `b955e9cda3e24bfa4dd9f6fd3597f1aa1d6a5ccb`, tree `e8b075a927e36c81a64a8435b59088300ce696ee` | Initial observation and validator comparison source; preserve it instead of relabeling it current. Dated follow-up states in that inventory remain historical. |
| Reviewed environment integration | [PR #57](https://github.com/menaje/2d-cad-viewer/pull/57), merged commit `fb625033c2a6d09d1a8be7e261f54c0ab6fef546` | Repository-local working environment was integrated into `dev`; this does not establish product Effective. |
| Current reviewed development baseline, observed 2026-09-11 | Remote default `dev`: commit `d2aacd31e36f4bcbc1175c0add59a7209f277ba0`, tree `b13383180bc84877419ed3a5c8332c03fe1e5349`; [PR #58](https://github.com/menaje/2d-cad-viewer/pull/58) records product document owners | Exact baseline for this navigation update. Re-observe the remote before subsequent work; a moving branch is a locator. |
| Stable branch observation, 2026-09-11 | `main`: commit `7910bd125f13b3bc3bcfc2e2af5276cf873a7efb` | Separate distribution history; it is not the current development environment baseline or a new release approval. |
| Actual repository application | `git rev-parse HEAD HEAD^{tree}`; `git status --porcelain=v2`; current files plus focused validation results | Record each checkout independently. A fetched remote, old receipt or successful check at another input does not prove this checkout is current. |
| Document projection source | [document-generation.json](document-generation.json) `sourceRevision` and [document catalog](generated/document-catalog.json) | Exact committed document bytes used by the generator; distinct from both the historical inventory baseline and the commit containing generated output. |

| Requirement | Repository application and owner/configuration | Verification / evidence |
| --- | --- | --- |
| Work isolation, visibility and exact-input evidence | This contract; [AGENTS](../AGENTS.md); [environment inventory](environment.json) | `check:governance`, `test:governance`, `check:public-surface`; exact source/tree, input digests and limitations |
| Product and API ownership | [Architecture](../docs/architecture.md), [boundary ADR](../docs/adr/ADR-0001-viewer-core-boundary.md), package READMEs | Existing product contracts own details; the focused document check verifies registered metadata, local links and projection bytes |
| Version, stage and publication decisions | [Distribution](../docs/distribution.md), repository-owned locators in the inventory; unresolved decisions in [#53](https://github.com/menaje/2d-cad-viewer/issues/53) | `check:governance` checks observations; product/release evidence and unresolved authority remain HOLD |
| Document ownership and generated records | [Governed document registry](governed-documents.json), [generation instructions](README.md), `scripts/document-governance.mjs` | `check:documents`; regenerate only from an exact committed source and record output digests/drift separately |

## Verification invocation map

| Invocation | Actual coverage and trigger | Side effects / evidence limit |
| --- | --- | --- |
| Manual `pnpm run check:governance` | `scripts/check-governance.mjs`: historical-baseline/input checks, allowed change paths, AGENTS boundaries and public-surface scan | Reads repository inputs/Git objects and may fetch missing exact public history; requires committed clean evidence inputs. Local focused evidence only |
| Manual `pnpm run test:governance` | `scripts/check-governance.test.mjs` and `scripts/check-public-surface.test.mjs` | Focused tests may create temporary fixtures; no product qualification |
| Manual `pnpm run check:public-surface` | `scripts/check-public-surface.mjs`; tracked and non-ignored untracked surfaces | Read-only scan; human contextual review is also required |
| Manual `pnpm run check:documents` | `scripts/document-governance.mjs validate`; registered documents and generated projections | Read-only validation; fails when source bytes differ from the recorded generation revision |
| Manual `pnpm run generate:documents -- <40-hex-source-revision>` | Existing document generator, after committing governed source changes | Writes `document-generation.json` and two files under `governance/generated/`; run twice for the same exact source and compare tracked/untracked drift |
| Aggregate `pnpm check` / `pnpm test` | Neither aggregate invokes the four focused commands above | Product command sets are separate and may build/package or qualify artifacts; do not run them for this navigation-only change |
| Hosted `.github/workflows/ci.yml` | Push to `main`, `dev`, `prerelease`, and pull requests; runs product Rust/package checks and qualification, not the four focused commands | Automatic hosted runs are separate observations; no local focused result substitutes for hosted Gate evidence |
| Server-required checks, observed 2026-09-11 | `dev` branch-protection API returned `Branch not protected`; applicable branch rules API returned `[]` | No required status check observed for `dev`; re-observe before integration. Workflow existence alone does not make a check server-required |

## Authority and lifecycle

The repository owns the rules, locators and public evidence in this contract.
[environment.json](environment.json) records an exact public source SHA/tree and
observations; it never becomes a competing source for package versions. Read
version values from their repository-owned locators. A generated catalog owns
neither package identity nor release approval. Existing accepted
[distribution](../docs/distribution.md), [architecture](../docs/architecture.md)
and [ADR](../docs/adr/ADR-0001-viewer-core-boundary.md) retain their product
meanings; unresolved conflicts are HOLD and go to #53, not silent override.

Ordinary development integrates feature branches into default `dev`. The target
product lifecycle uses `dev -> release/X.Y.Z -> main`; the release branch is
short-lived and main accepts stable releases only. Current workflows still
implement numeric minor parity and `dev -> prerelease -> main`. That mismatch
is **HOLD**, pending an explicit repository-owner decision and separately scoped
implementation. This contract changes no workflow, branch protection or release
behavior. Feature integration, mapping completion and document acceptance grant
no candidate, release or publication authority.

Mapping is complete when observed authorities, classifications, evidence gaps,
visibility and responsible follow-ups are recorded. Accepted means reviewed
rules; Effective additionally requires implemented rules and an accepted exact
verified baseline. No integration baseline or product Effective is claimed here.

## Independent version sources and stage observations

| Train | Repository-owned version source and members | Stage observation | Disposition |
| --- | --- | --- | --- |
| VS Code product | `package.json#/version`; `apps/vscode-extension/package.json#/version` is its mirror. Version-bound converters and source archives share this product train. | `scripts/release-channel.mjs#determineReleaseChannel` derives channel from route and numeric minor parity. There is no standalone stage field. | Source observed; new candidate/stable authority HOLD (#53). Root `private: true` prevents npm publication; it is not repository visibility or a placeholder. |
| Core / UI / render protocol | `packages/viewer-core/package.json#/version`; UI and render-protocol manifests align as one fixed group, independent of VS Code and WebGL. | `compatibility/viewer-core.json#/distribution/releaseStage`, consumed by `viewer-packages.yml`, describes historical distribution. `/viewerCore/releaseStage` does not exist. | Historical prerelease observation only; `tagPublicationApproved=false`; new publication HOLD (#53). |
| WebGL / DWG Scene Source | `packages/webview/package.json#/version`; `packages/dwg-scene-source/package.json#/version` aligns within this independent train. | `compatibility/viewer-webgl.json#/distribution/releaseStage` is historical, while `viewer-webgl.yml` hardcodes `--prerelease`. | Unique executable stage authority unresolved; fail closed HOLD (#53). |

Inventory IDs identify local mapping rows only. They are not approved release
unit IDs or a changeset/publication registry. An unknown or ambiguous locator,
multiple stage sources, stale observation or mirror drift fails focused
validation and keeps authority HOLD. Matching numbers do not establish authority.

## Classifications and historical preservation

- A **mirror** copies an identified source; it cannot select a version. Core/UI
  and WebGL runtime exported version constants are **runtime copies**. Render
  protocol `0.1.0` and API/schema/cache versions are independent **contract
  identities**, not package version drift.
- A **placeholder** requires explicit owner classification; no observed field
  is assumed to be one. In particular, root `0.1.8`, Cargo workspace `0.1.0`
  and native adapter `0.1.0` must not be replaced with `0.0.0` by inference.
- The legacy adapter extension is a **Legacy/Reference qualification package**,
  not a current Marketplace product. The native document adapter is an internal
  query-preview/contract package; the Cargo converter version and its lock
  mirror are local tooling identities, not independent publication trains.
- Lock format versions are schemas; dependency resolutions are snapshots.
  Engine catalogs and VSIX embedded metadata are **generated artifact copies**
  from release inputs and actual bytes. They create no version or stage authority.
- Compatibility `distribution` and retained evidence describe **historical
  evidence**, not current development qualification. WebGL's development source
  still has the same numeric package identity as historical archives, but its
  dependencies differ; `publishedInDistribution=false` stays intact. Mixed
  compatibility dependencies are not normalized here.
- Preserve suffix-free historical prerelease tags, versions, filenames, byte
  sizes, digests and qualification results. Do not rename, republish, retag or
  infer enforced immutability. The Core `0.1.1` raw digest discrepancy and
  unverified attestation remain #53 HOLD with both observations preserved.

Future release work needs one confirmed repository-owned version source and
one stage authority per approved release unit, with explicit fixed/independent
membership. Each change fragment must name its affected unit. Official versions
are not bumped per development commit. Compatible fixes use PATCH; additions
use MINOR; post-1.0 breaking changes use MAJOR. Before 1.0, additive or breaking
structure uses MINOR and breaking changes require an explicit BREAKING marker.
Right-hand components reset when a higher component increments. New candidates
must use unused `X.Y.Z-rc.N` identities starting at 1; iteration changes only N.
Stable removes the suffix from the last candidate, preserving its numeric base,
artifact bytes, size and digest; changed bytes require a new candidate. Stages
are `development`, `candidate`, `prerelease`, `stable`, `deprecated`. A prerelease
flag alone is not RC identity. These requirements remain unimplemented/HOLD;
this environment neither selects a candidate nor adds release automation.

## Gates, focused commands and exact evidence

The execution profile is `hosted-public`; the ordered Gate set is closed.
The following existing command/workflow mappings are observations, not a claim
that every command is currently wired into CI or that any Gate has passed.

| Gate | Existing repository command observation | Workflow observation | Required evidence | Readiness |
| --- | --- | --- | --- | --- |
| `fast` | `pnpm run check:documents`; `pnpm run check:release-channel` | `.github/workflows/ci.yml` | input-digest, command-set-digest, execution-provenance, result | HOLD |
| `affected` | `pnpm run test:viewer-contracts` | `.github/workflows/ci.yml` | affected-paths, affected-contracts, command-set-digest, execution-provenance, result | HOLD |
| `full-integration` | `pnpm check` | `.github/workflows/ci.yml` | repository-wide-command-set, generated-drift-check, execution-provenance, result | HOLD |
| `prerelease` | `pnpm install --frozen-lockfile`; `pnpm check` | `.github/workflows/release-route.yml` | candidate-provenance, environment-provenance, execution-provenance, result | HOLD |
| `release` | `pnpm install --frozen-lockfile`; `pnpm check` | `.github/workflows/release.yml` | release-artifact-provenance, release-readiness, execution-provenance, result | HOLD |

All five require hosted execution evidence for their exact reviewed input.
Validation Classes `fast`, `affected`, `full` map only to the first three Gates;
class selection never grants promotion. Full reuse keys, duplicate/resume policy
and long-running classification remain unknown/HOLD. No new Gate is introduced.

For governance-only work run `pnpm run check:governance`,
`pnpm run test:governance`, `pnpm run check:public-surface`, and
`pnpm run check:documents`. These require Node and Git, without installing
product dependencies or calling release scripts. Do not run full product tests.
The existing product `check`/`test` scripts and workflows remain unchanged.
Automatic CI triggered by a Draft PR is a separate hosted observation. Do not
suppress required checks or use commit-message skip markers to avoid product CI.
Environment completion uses focused governance evidence; it does not claim a
product Gate PASS from skipped, pending or unobserved workflow results.

Evidence must bind the public repository, exact source commit/tree, changed
paths/contracts, input file SHA-256 values, command-set digest, executor/tool
versions, command result and limitations. Working-tree results also need file
digests and a later committed-head check. Generated records bind their exact
source revision separately from the commit containing generated bytes. Release
evidence would additionally require exact unit/version/stage, tag object and
peeled commit, artifact filename/size/SHA-256 and accepted conformance/provenance.
Unknown, stale or contradictory evidence is HOLD. A result cannot be reused for
a different input, and local results cannot substitute for required hosted ones.

## Unpublished documentation payload evidence

The [compatibility rule](../compatibility/README.md#environmentdocumentation-only-development-repack)
narrowly permits PR #57's three package README corrections to change archive
bytes while public API/runtime/package manifests/versions/dependencies stay
identical to the recorded baseline. The non-payload Core manifest test may only
replace its stale development-evidence absence assertion with source/report
validation; any other test edit fails closed. Exact source commit precedes the separate
artifact-evidence commit; the source cannot contain its own development evidence.
Only classified environment files are allowed before that source, and only
specified evidence/catalog digest records between it and the original measured
receipt commit `0f1b0f0c4bf2ed6ed85bfd34e67e774a81e63ae1`. That historical interval
still uses the strict evidence-only classification. After the receipt, current
maintenance additionally permits exactly `AGENTS.md`, `governance/adoption.md`,
`scripts/development-package-evidence.mjs` and its `.test.mjs` file. Current
tracked and non-ignored untracked changes are checked against this narrow list
plus the existing evidence/catalog paths. The original development record must
match the receipt, and package source bytes must still match the qualified source.
Package README/source/test/manifests, qualifier behavior, dependencies and
workflows receive no new allowance. Validator changes require the existing
`test:development-artifacts` command and `check:governance` retained source/report
checks. The separate `check:development-artifacts` command creates two temporary
packs per package and removes them afterward; it remains restricted to separately
scoped artifact verification. All other changes fail
closed. Two actual packs, normalized archive and content digests/sizes, source
ancestry/tree and artifact-only consumer conformance are required. Historical
`distribution.artifacts` and retained qualification evidence remain unchanged.
The new checks are `test:development-artifacts` and `check:development-artifacts`;
`qualify:viewer-boundary` now rejects unbound development evidence before using
its existing development-artifact selection path. This is not product/release
qualification authority. The scoped Windows UI comparison records one bounded
unchanged workflow execution per exact base/head and defers product remediation.

## Public-surface enforcement and scope

Every public document, metadata/generated field, issue, PR, commit, log and test
fixture must stand alone. Non-public product or repository identities, roles,
consumption relationships, paths, revisions, digests and backlinks are forbidden.
Do not import unavailable authority text or invent public provenance for it.
Public fixtures use synthetic identities only. Public artifact and API identities
already owned here remain intact; geometric terminology is not product identity.

The public-surface validator scans tracked and untracked, non-ignored Markdown,
JSON and YAML surfaces, including package metadata, documentation, compatibility
evidence, governance exports and workflows. It checks repository links against
reviewed public identities, rejects local/sibling provenance, inspects structured
visibility/relationship fields and flags undeclared named actors in authority or
consumer contexts. Generated catalogs are also checked for exact source drift.
This is bounded automation: human contextual review is still required for prose,
opaque hashes and external issue/PR bodies; no heuristic can prove arbitrary
text contains no indirect disclosure. Diagnostics never echo suspect contents.

Allowed environment changes are AGENTS/environment documents, governance
metadata, focused validators/tests, added package scripts and minimal public
boundary wording corrections. Preserve existing user changes, historical
artifacts and all product behavior. No product source/runtime/rendering/native/
WASM/package-version/dependency/deployment changes, full product testing, merge,
tag, release, publication, promotion or capability admission is in scope.

## Tracked HOLDs and document ownership

[#53](https://github.com/menaje/2d-cad-viewer/issues/53) is owned by the repository
maintainer/release owner: stage authority, approved unit IDs, lifecycle/channel
migration, Core 0.1.1 evidence and registry verification. It needs explicit owner
decisions and exact original/public artifact evidence, not guessed normalization.

[#54](https://github.com/menaje/2d-cad-viewer/issues/54) is owned by the maintainer
and native/WASM capability owner: query-preview remains, actual writer remains
blocked, WASM remains rejected. Renewed admission needs separately scoped work
and exact candidate/baseline evidence. Historical #28 completion is preserved.

[#55](https://github.com/menaje/2d-cad-viewer/issues/55) is owned by the product
documentation/API maintainer: architecture and the ADR own package boundaries,
[licensing](../docs/licensing.md) owns license explanations, and package READMEs
own API/usage explanations. This change only corrects public-boundary wording;
full documentation consolidation and owner acceptance remain follow-up work.
Only overlapping files/contracts require sequencing. Individual reviewers and
release/capability owners remain to be designated by the repository owner.

Remote protection, product Effective, automation, promotion and publication
remain HOLD. Rollback for this environment is a reviewed inverse change of its
files and regenerated document catalog at an exact public source revision;
never reset history or rewrite tags, archives or historical evidence.
