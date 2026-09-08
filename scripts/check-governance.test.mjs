import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEnvironment, validatePackageChange, validateChangedPaths, pointer, commands } from './check-governance.mjs';
const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const baseline = JSON.parse(read('governance/environment.json'));
const clone = () => structuredClone(baseline);

test('validates observed locators while all authority remains HOLD', () => {
  assert.doesNotThrow(() => validateEnvironment(clone()));
});
for (const [name, mutate, pattern] of [
  ['mapping becomes Effective', (env) => { env.effective = true; }, /mapping cannot grant/],
  ['publication approved', (env) => { env.units[1].publicationAuthority = 'PASS'; }, /cannot admit/],
  ['invented release ID', (env) => { env.units[0].approvedReleaseUnitId = 'example-unit'; }, /mapping ID/],
  ['root private flag mistaken for placeholder', (env) => { env.placeholderSources.push('package.json'); }, /placeholder/],
  ['competing version source', (env) => { env.units[1].versionSource.path = 'packages/viewer-ui/package.json'; }, /single repository-owned/],
  ['stage guessed from branch', (env) => { env.units[0].stage.kind = 'candidate'; }, /stage authority/],
  ['stale Core stage pointer', (env) => { env.units[1].stage.locator.field = '/viewerCore/releaseStage'; }, /stage authority/],
  ['missing stage field', (env) => { delete env.units[1].stage.locator.field; }, /closed fields/],
  ['two matching WebGL observations treated as authority', (env) => { env.units[2].stage.uniqueAuthority = 'confirmed'; }, /must remain unresolved/],
  ['new stage approval', (env) => { env.units[2].stage.candidateAuthority = 'PASS'; }, /stage authority/],
  ['missing fixed-group member', (env) => { env.units[1].members.pop(); }, /group membership/],
  ['missing mirror', (env) => { env.units[2].mirrors.pop(); }, /mirror inventory/],
  ['historical mirror promoted to source', (env) => { env.units[1].mirrors.at(-1).role = 'version-source'; }, /classification/],
  ['omitted digest coverage', (env) => { env.observations.pop(); }, /input coverage/],
  ['stale digest', (env) => { env.observations[0].sha256 = '0'.repeat(64); }, /digest drift/],
  ['duplicated digest coverage', (env) => { env.observations.push(env.observations[0]); }, /duplicate/],
  ['missing runtime-copy classification', (env) => { env.classifications = env.classifications.filter((entry) => entry.kind !== 'runtime-copy'); }, /classification inventory/],
  ['missing follow-up', (env) => { env.followups.pop(); }, /follow-up inventory/],
  ['unknown authority field', (env) => { env.remoteAuthority = 'example'; }, /closed fields/],
]) test(`fails closed: ${name}`, () => {
  const env = clone(); mutate(env);
  assert.throws(() => validateEnvironment(env), pattern);
});
for (const [name, path, edit, pattern] of [
  ['fixed member drift', 'packages/viewer-ui/package.json', (text) => { const item = JSON.parse(text); item.version = '9.9.9'; return JSON.stringify(item); }, /version\/mirror disagreement/],
  ['runtime copy drift', 'packages/viewer-core/src/constants.mjs', (text) => text.replace('ViewerCoreVersion = "0.1.3"', 'ViewerCoreVersion = "9.9.9"'), /runtime version copy/],
  ['historical development conflation', 'compatibility/viewer-webgl.json', (text) => { const item = JSON.parse(text); item.developmentQualification.publishedInDistribution = true; return JSON.stringify(item); }, /development evidence/],
  ['historical publication approval', 'compatibility/viewer-core.json', (text) => { const item = JSON.parse(text); item.distribution.tagPublicationApproved = true; return JSON.stringify(item); }, /publication approval/],
]) test(`detects actual input ${name}`, () => {
  assert.throws(() => validateEnvironment(clone(), (input) => input === path ? edit(read(input)) : read(input)), pattern);
});
test('JSON pointer lookup never invents missing stage authority', () => {
  assert.equal(pointer({ distribution: { releaseStage: 'prerelease' } }, '/distribution/releaseStage'), 'prerelease');
  assert.throws(() => pointer({ viewerCore: {} }, '/viewerCore/releaseStage'), /missing authority/);
});
test('allows only focused scripts and preserves every product metadata field', () => {
  const before = { name: 'example', version: '0.1.8', private: true, dependencies: { example: '1.0.0' }, scripts: { test: 'existing-product-test' } };
  const after = { ...structuredClone(before), scripts: { ...before.scripts, ...commands } };
  assert.doesNotThrow(() => validatePackageChange(before, after));
  for (const mutate of [(item) => { item.version = '0.1.9'; }, (item) => { item.dependencies.example = '2.0.0'; }, (item) => { item.scripts.test = 'true'; }, (item) => { item.scripts.postinstall = 'example'; }]) {
    const edited = structuredClone(after); mutate(edited);
    assert.throws(() => validatePackageChange(before, edited), /forbidden|only focused/);
  }
});
test('rejects product source, historical evidence, workflow and dependency edits', () => {
  assert.doesNotThrow(() => validateChangedPaths(['AGENTS.md', 'governance/adoption.md', 'package.json']));
  for (const path of ['packages/viewer-core/src/constants.mjs', 'compatibility/evidence/viewer-boundary-0.1.1-2026-08-04.json', '.github/workflows/ci.yml', 'pnpm-lock.yaml', 'packages/webview/package.json', 'adapters/libredwg/main.c']) {
    assert.throws(() => validateChangedPaths([path]), /outside the authorized/);
  }
});
