import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateArtifactRecords, validateChangePaths, validateMaintenancePaths, validateCompatibilityPreservation, validateRootMetadata, validatePackageFiles, compareMeasuredArtifacts, validateSourceBinding, validateQualificationReport, validateQualifierChange, validateManifestTestChange } from './development-package-evidence.mjs';

const manifest = JSON.parse(readFileSync(new URL('../compatibility/viewer-core.json', import.meta.url)));
const artifacts = structuredClone(manifest.distribution.artifacts);
test('separates measured records while preserving published identity', () => {
  const measured = structuredClone(artifacts);
  measured.viewerCore.sha256 = '1'.repeat(64);
  measured.viewerCore.contentSha256 = '2'.repeat(64);
  measured.viewerCore.bytes += 1;
  assert.doesNotThrow(() => validateArtifactRecords(measured, artifacts));
  assert.throws(() => compareMeasuredArtifacts(measured, artifacts));
});
for (const [name, edit] of [
  ['missing package', (item) => { delete item.viewerUi; }],
  ['different version identity', (item) => { item.viewerCore.file = 'example-0.1.4.tgz'; }],
  ['invalid digest', (item) => { item.viewerCore.sha256 = 'synthetic'; }],
  ['fractional size', (item) => { item.viewerCore.bytes = 1.5; }],
  ['zero size', (item) => { item.viewerCore.bytes = 0; }],
  ['unexpected approval', (item) => { item.viewerCore.publicationApproved = true; }],
]) test(`rejects ${name}`, () => {
  const edited = structuredClone(artifacts); edit(edited);
  assert.throws(() => validateArtifactRecords(edited, artifacts));
});
test('environment allowance does not permit runtime, API, manifest, dependency or workflow edits', () => {
  assert.doesNotThrow(() => validateChangePaths(['packages/viewer-core/README.md', 'AGENTS.md']));
  for (const path of ['packages/viewer-core/src/constants.mjs', 'packages/render-protocol/src/index.mjs', 'packages/viewer-ui/package.json', 'pnpm-lock.yaml', '.github/workflows/release.yml', 'packages/viewer-core/LICENSE', 'apps/vscode-extension/src/extension.ts']) {
    assert.throws(() => validateChangePaths([path]), /exceeds/);
  }
});
test('evidence commit cannot change the qualified source or documentation', () => {
  assert.doesNotThrow(() => validateChangePaths(['compatibility/viewer-core.json'], { evidenceOnly: true }));
  for (const path of ['AGENTS.md', 'packages/viewer-core/README.md', 'scripts/development-package-evidence.mjs', 'package.json']) assert.throws(() => validateChangePaths([path], { evidenceOnly: true }), /exceeds/);
});
test('post-receipt maintenance admits only the named governance paths and keeps historical classification strict', () => {
  for (const path of ['AGENTS.md', 'governance/adoption.md', 'scripts/development-package-evidence.mjs', 'scripts/development-package-evidence.test.mjs']) {
    assert.doesNotThrow(() => validateMaintenancePaths([path]));
    assert.throws(() => validateChangePaths([path], { evidenceOnly: true }), /exceeds/);
  }
  for (const path of ['packages/viewer-core/README.md', 'packages/viewer-core/src/constants.mjs', 'packages/viewer-core/package.json', 'packages/viewer-core/test/viewer-core.test.mjs', 'apps/vscode-extension/src/extension.ts', 'scripts/qualify-viewer-boundary.mjs', 'scripts/example.mjs', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'governance/unreviewed.json']) {
    assert.throws(() => validateMaintenancePaths([path]), /exceeds/);
  }
});
test('historical digest, size, identity and all other compatibility fields are immutable', () => {
  const after = structuredClone(manifest);
  after.developmentQualification = { publishedInDistribution: false };
  assert.doesNotThrow(() => validateCompatibilityPreservation(manifest, after));
  for (const field of ['sha256', 'bytes', 'file']) {
    const edited = structuredClone(after); edited.distribution.artifacts.viewerCore[field] = 'synthetic';
    assert.throws(() => validateCompatibilityPreservation(manifest, edited));
  }
  after.viewerCore.version = '0.1.4';
  assert.throws(() => validateCompatibilityPreservation(manifest, after));
});
test('package tree permits README-only differences and rejects all other bytes or modes', () => {
  const before = [{ path: 'packages/viewer-core/README.md', mode: '100644', blob: '1'.repeat(40) }, { path: 'packages/viewer-core/src/index.mjs', mode: '100644', blob: '2'.repeat(40) }];
  const after = structuredClone(before); after[0].blob = '3'.repeat(40);
  assert.doesNotThrow(() => validatePackageFiles(before, after));
  after[1].blob = '4'.repeat(40);
  assert.throws(() => validatePackageFiles(before, after));
  after[1] = { ...before[1], mode: '100755' };
  assert.throws(() => validatePackageFiles(before, after));
});
test('root package behavior and dependencies remain unchanged', () => {
  const current = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const before = structuredClone(current);
  for (const key of ['check:governance', 'test:governance', 'check:public-surface', 'check:development-artifacts', 'test:development-artifacts']) delete before.scripts[key];
  assert.doesNotThrow(() => validateRootMetadata(before, current));
  for (const mutate of [(item) => { item.scripts.test = 'true'; }, (item) => { item.version = '0.1.9'; }, (item) => { item.devDependencies.example = '1.0.0'; }]) {
    const edited = structuredClone(current); mutate(edited);
    assert.throws(() => validateRootMetadata(before, edited));
  }
});
test('missing, moving or abbreviated source identity fails before any fetch', () => {
  for (const sourceRevision of [undefined, 'dev', 'c123d9a']) assert.throws(() => validateSourceBinding({ sourceRevision }), /exact source revision/);
});
test('a real source commit with a false tree cannot qualify artifacts', () => {
  assert.throws(() => validateSourceBinding({ sourceRevision: 'c123d9a541afcf4cfb604776dabb828870aa5e3c', sourceTree: '0'.repeat(40), baselineRevision: 'b955e9cda3e24bfa4dd9f6fd3597f1aa1d6a5ccb', classification: 'environment-documentation-only', publishedInDistribution: false, feature: 'environment-documentation-repack', sourceVersion: '0.1.3', command: 'pnpm run qualify:viewer-boundary', evidence: 'compatibility/evidence/viewer-boundary-development-environment.json', releaseReadiness: 'HOLD' }), /source tree mismatch/);
});
test('retained report is bound to exact source and every measured artifact', () => {
  const development = { status: 'passed', sourceRevision: '1'.repeat(40), sourceTree: '2'.repeat(40), artifacts };
  const report = { sourceRevision: development.sourceRevision, sourceTree: development.sourceTree, report: { status: 'passed-viewer-owned-development-boundary', scope: { deploymentPerformed: false }, artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, { ...value, publishedInDistribution: false, runnerRepackByteIdentical: true }])), artifactOnlyConsumer: { conformance: { stagedAtomicGeometryPickCommit: true } } } };
  const bytes = Buffer.from(JSON.stringify(report));
  development.evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => validateQualificationReport(development, bytes));
  development.sourceRevision = '3'.repeat(40);
  assert.throws(() => validateQualificationReport(development, bytes));
  development.sourceRevision = report.sourceRevision;
  development.artifacts = structuredClone(artifacts); development.artifacts.viewerCore.bytes += 1;
  assert.throws(() => validateQualificationReport(development, bytes));
  assert.throws(() => validateQualificationReport(development, Buffer.from('{}')), /report digest/);
});

test('qualifier correction cannot weaken historical or consumer assertions', () => {
  const before = execFileSync('git', ['show', 'b955e9cda3e24bfa4dd9f6fd3597f1aa1d6a5ccb:scripts/qualify-viewer-boundary.mjs'], { encoding: 'utf8' });
  const current = readFileSync(new URL('./qualify-viewer-boundary.mjs', import.meta.url), 'utf8');
  assert.doesNotThrow(() => validateQualifierChange(before, current));
  assert.throws(() => validateQualifierChange(before, current.replace('assert.equal(archiveDigest, expected.sha256);', '')));
});

test('non-payload manifest test changes only the stale absence assertion', () => {
  const before = execFileSync('git', ['show', 'b955e9cda3e24bfa4dd9f6fd3597f1aa1d6a5ccb:packages/viewer-core/test/viewer-core.test.mjs'], { encoding: 'utf8' });
  const current = readFileSync(new URL('../packages/viewer-core/test/viewer-core.test.mjs', import.meta.url), 'utf8');
  assert.doesNotThrow(() => validateManifestTestChange(before, current));
  assert.throws(() => validateManifestTestChange(before, current.replace('validateSourceBinding(manifest.developmentQualification);', '')));
  assert.throws(() => validateManifestTestChange(before, current.replace('assert.equal(manifest.distribution.published, true);', '')));
});
