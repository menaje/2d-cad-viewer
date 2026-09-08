import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSourceBinding, validateQualificationReport } from './development-package-evidence.mjs';
import { checkPublicSurface, repositoryPath, root } from './check-public-surface.mjs';

export const commands = Object.freeze({
  'check:governance': 'node scripts/check-governance.mjs',
  'test:governance': 'node --test scripts/check-governance.test.mjs scripts/check-public-surface.test.mjs',
  'check:public-surface': 'node scripts/check-public-surface.mjs',
  'check:development-artifacts': 'node scripts/development-package-evidence.mjs verify',
  'test:development-artifacts': 'node --test scripts/development-package-evidence.test.mjs',
});
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => JSON.stringify(sorted(value));
const fail = (message) => { throw new Error(`HOLD: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const read = (path) => readFileSync(repositoryPath(path), 'utf8');
const json = (path) => JSON.parse(read(path));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const baselineFile = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], { cwd: root });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shape = (value, keys, label) => assert(value && same(Object.keys(value).sort(), [...keys].sort()), `${label}: closed fields required`);

const layouts = [
  { id: 'vscode-product', source: 'package.json', members: ['apps/vscode-extension/package.json'], kind: 'derived-route', stagePath: 'scripts/release-channel.mjs', stageField: 'determineReleaseChannel' },
  { id: 'core-ui-render-protocol', source: 'packages/viewer-core/package.json', members: ['packages/viewer-core/package.json', 'packages/viewer-ui/package.json', 'packages/render-protocol/package.json'], kind: 'historical-distribution', stagePath: 'compatibility/viewer-core.json', stageField: '/distribution/releaseStage' },
  { id: 'webgl-dwg-scene-source', source: 'packages/webview/package.json', members: ['packages/webview/package.json', 'packages/dwg-scene-source/package.json'], kind: 'ambiguous-executable', stagePath: 'compatibility/viewer-webgl.json', stageField: '/distribution/releaseStage' },
];
const expectedMirrors = [
  ['apps/vscode-extension/package.json#/version'],
  ['packages/viewer-ui/package.json#/version', 'packages/render-protocol/package.json#/version',
    ...['viewerCore', 'viewerUi', 'renderProtocol'].map((key) => `compatibility/viewer-core.json#/${key}/version`),
    ...['viewerCore', 'viewerUi', 'renderProtocol'].map((key) => `compatibility/viewer-core.json#/distribution/packageVersions/${key}`)],
  ['packages/dwg-scene-source/package.json#/version', 'compatibility/viewer-webgl.json#/viewerWebGl/version', 'compatibility/viewer-webgl.json#/dwgSceneSource/version'],
];
export function pointer(value, field) {
  assert(typeof field === 'string' && /^\/(?:[^~]|~[01])+$/u.test(field), 'JSON pointer required');
  for (const part of field.slice(1).split('/').map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    assert(value && Object.hasOwn(value, part), 'missing authority field');
    value = value[part];
  }
  return value;
}

export function validateEnvironment(env, readText = read) {
  shape(env, ['schemaVersion', 'repository', 'visibility', 'baseline', 'mappingStatus', 'effective', 'automationStatus', 'releaseReadiness', 'placeholderSources', 'units', 'classifications', 'observations', 'followups'], 'environment');
  assert(env.schemaVersion === '1.0.0' && env.repository === 'menaje/2d-cad-viewer' && env.visibility === 'public', 'environment identity');
  shape(env.baseline, ['branch', 'commit', 'tree'], 'baseline');
  assert(env.baseline.branch === 'dev' && /^[a-f0-9]{40}$/u.test(env.baseline.commit) && /^[a-f0-9]{40}$/u.test(env.baseline.tree), 'exact dev baseline required');
  assert(env.mappingStatus === 'complete-with-tracked-holds' && env.effective === false && env.automationStatus === 'HOLD' && env.releaseReadiness === 'HOLD', 'mapping cannot grant Effective or release authority');
  assert(same(env.placeholderSources, []), 'unconfirmed placeholder authority');
  assert(Array.isArray(env.units) && env.units.length === layouts.length, 'exact three observed trains required');
  const readJson = (path) => JSON.parse(readText(path));
  for (const [index, expected] of layouts.entries()) {
    const unit = env.units[index];
    shape(unit, ['mappingId', 'approvedReleaseUnitId', 'versionSource', 'members', 'mirrors', 'stage', 'sourceLifecycle', 'automationStatus', 'publicationAuthority', 'followup'], 'mapping row');
    shape(unit.versionSource, ['path', 'field', 'role'], 'version source');
    assert(unit.mappingId === expected.id && unit.approvedReleaseUnitId === null && unit.followup === 53, 'mapping ID is not approved release-unit authority');
    assert(unit.versionSource.path === expected.source && unit.versionSource.field === '/version' && unit.versionSource.role === 'version-source', 'single repository-owned version source required');
    assert(same(unit.members, expected.members), 'group membership drift');
    const version = pointer(readJson(expected.source), '/version');
    assert(/^\d+\.\d+\.\d+$/u.test(version), 'observed package version drift');
    assert(same(unit.mirrors.map((entry) => `${entry.path}#${entry.field}`), expectedMirrors[index]), 'mirror inventory drift');
    for (const mirror of unit.mirrors) {
      shape(mirror, ['path', 'field', 'role'], 'mirror');
      assert(mirror.role === (mirror.field.startsWith('/distribution/') ? 'historical-mirror' : 'mirror'), 'mirror classification drift');
      assert(pointer(readJson(mirror.path), mirror.field) === version, 'version/mirror disagreement');
    }
    for (const member of unit.members) assert(readJson(member).version === version, 'fixed group version disagreement');
    assert(unit.sourceLifecycle === 'development' && unit.automationStatus === 'HOLD' && unit.publicationAuthority === 'HOLD', 'observed stage cannot admit development publication');
    const stage = unit.stage;
    shape(stage, index === 0 ? ['kind', 'locator', 'historicalStage', 'candidateAuthority'] : index === 1 ? ['kind', 'locator', 'observedValue', 'executable', 'candidateAuthority'] : ['kind', 'locator', 'observedValue', 'executable', 'executableRule', 'uniqueAuthority', 'candidateAuthority'], 'stage');
    shape(stage.locator, ['path', 'field', 'role'], 'stage locator');
    assert(stage.kind === expected.kind && stage.locator.path === expected.stagePath && stage.locator.field === expected.stageField && stage.candidateAuthority === 'HOLD', 'stage authority is missing, stale or ambiguous');
    assert(stage.locator.role === (index === 0 ? 'executable-rule' : 'stage-observation'), 'stage locator classification');
    if (index === 0) assert(stage.historicalStage === 'prerelease' && readText(expected.stagePath).includes('function determineReleaseChannel('), 'derived channel observation drift');
    else {
      const compatibility = readJson(expected.stagePath);
      assert(stage.observedValue === 'prerelease' && pointer(compatibility, expected.stageField) === stage.observedValue, 'historical stage drift');
      assert(compatibility.distribution.tagPublicationApproved === false && compatibility.distribution.automaticStablePromotion === false, 'publication approval drift');
      assert(stage.executable === (index === 1 ? '.github/workflows/viewer-packages.yml' : '.github/workflows/viewer-webgl.yml'), 'stage executable drift');
      if (index === 1) assert(readText(stage.executable).includes('distribution.releaseStage'), 'Core stage consumer drift');
      else {
        assert(stage.uniqueAuthority === null && stage.executableRule === 'hardcoded --prerelease', 'ambiguous WebGL authority must remain unresolved');
        assert(readText(stage.executable).includes('--prerelease') && !readText(stage.executable).includes('distribution.releaseStage'), 'WebGL executable observation drift');
        assert(compatibility.developmentQualification.publishedInDistribution === false, 'development evidence must not claim historical publication');
      }
    }
  }
  const requiredKinds = ['runtime-copy', 'contract-identity', 'legacy-reference', 'internal-contract-package', 'local-tooling', 'inherited', 'lock-snapshot', 'generated-artifact-copy', 'historical-evidence', 'development-evidence', 'deferred-baseline', 'document-projection'];
  assert(same([...new Set(env.classifications.map((entry) => entry.kind))].sort(), requiredKinds.sort()), 'classification inventory incomplete');
  assert(env.classifications.length === 18, 'classification rows incomplete');
  for (const entry of env.classifications) {
    assert(typeof entry.path === 'string' && typeof entry.field === 'string', 'classification locator required');
    const text = readText(entry.path);
    if (entry.kind === 'runtime-copy') {
      const value = new RegExp(`export const ${entry.field} = "([^"]+)";`, 'u').exec(text)?.[1];
      assert(value === readJson(entry.source).version, 'runtime version copy drift');
    }
  }
  const observed = new Set();
  for (const observation of env.observations) {
    shape(observation, ['path', 'sha256', 'scope'], 'input observation');
    assert(!observed.has(observation.path) && /^[a-f0-9]{64}$/u.test(observation.sha256), 'duplicate or invalid input observation');
    observed.add(observation.path);
    let bytes = readText(observation.path);
    if (observation.path === 'package.json') {
      assert(observation.scope === 'non-script-metadata', 'root metadata scope');
      const { scripts, ...metadata } = JSON.parse(bytes);
      bytes = canonical(metadata);
    } else assert(observation.scope === 'file', 'exact file scope required');
    assert(sha256(bytes) === observation.sha256, 'observed input digest drift');
  }
  const requiredPaths = new Set([
    'package.json', 'compatibility/viewer-core.json', 'compatibility/viewer-webgl.json', 'compatibility/native-document-adapter.json',
    'scripts/release-channel.mjs', 'scripts/create-engine-catalog.mjs', '.github/workflows/viewer-packages.yml', '.github/workflows/viewer-webgl.yml', '.github/workflows/release.yml', '.github/workflows/release-route.yml',
    ...layouts.flatMap((entry) => [entry.source, ...entry.members]),
    ...env.classifications.filter((entry) => entry.kind !== 'document-projection').map((entry) => entry.path),
  ]);
  assert(same([...observed].sort(), [...requiredPaths].sort()), 'exact input coverage required');
  assert(same(env.followups.map((item) => item.issue), [53, 54, 55, 56]), 'follow-up inventory required');
  for (const item of env.followups) assert(item.url === `https://github.com/menaje/2d-cad-viewer/issues/${item.issue}` && item.stateObserved === 'OPEN' && item.observedOn === '2026-09-08', 'follow-up public observation drift');
}

export function validatePackageChange(before, after) {
  const { scripts: previous, ...oldMetadata } = before;
  const { scripts: current, ...newMetadata } = after;
  assert(same(oldMetadata, newMetadata), 'product metadata/version/dependency change forbidden');
  assert(same(current, { ...previous, ...commands }), 'only focused script additions allowed');
}

const boundaryPaths = [
  'compatibility/README.md', 'compatibility/viewer-core.json', 'docs/architecture.md',
  'docs/adr/ADR-0001-viewer-core-boundary.md', 'packages/render-protocol/README.md',
  'packages/viewer-core/README.md', 'packages/viewer-ui/README.md',
];
const allowedPaths = new Set([
  'AGENTS.md', 'package.json', 'governance/README.md', 'governance/adoption.md',
  'governance/environment.json', 'governance/public-boundary-corrections.json',
  'governance/governed-documents.json', 'governance/document-generation.json',
  'governance/generated/document-catalog.json', 'governance/generated/document-export.public.json',
  'scripts/check-governance.mjs', 'scripts/check-governance.test.mjs',
  'scripts/check-public-surface.mjs', 'scripts/check-public-surface.test.mjs',
  'scripts/development-package-evidence.mjs', 'scripts/development-package-evidence.test.mjs',
  'scripts/qualify-viewer-boundary.mjs',
  'compatibility/evidence/viewer-boundary-development-environment.json', ...boundaryPaths,
]);
export function validateChangedPaths(paths) {
  assert(paths.every((path) => allowedPaths.has(path)), 'change outside the authorized environment surface');
}
function validateBoundary(env) {
  const record = json('governance/public-boundary-corrections.json');
  assert(record.schemaVersion === '1.0.0' && record.baselineCommit === env.baseline.commit && record.productDocumentationConsolidationIssue === 55, 'boundary correction provenance');
  assert(same(record.corrections.map((entry) => entry.path).sort(), [...boundaryPaths].sort()), 'exact boundary correction scope required');
  for (const entry of record.corrections) {
    assert(entry.beforeSha256 === sha256(baselineFile(env.baseline.commit, entry.path)) && entry.afterSha256 === sha256(read(entry.path)), 'boundary before/after digest mismatch');
    assert(entry.historicalArtifactsChanged === false, 'historical artifact mutation forbidden');
  }
  // Noncontractual source registry descriptions may be removed. Every other
  // compatibility field, including public identity, distribution and evidence,
  // must remain byte-equivalent when serialized. No removed name is copied here.
  const previous = JSON.parse(baselineFile(env.baseline.commit, 'compatibility/viewer-core.json'));
  const current = json('compatibility/viewer-core.json');
  const { sources: oldSources, ...oldFields } = previous;
  const { sources: newSources, developmentQualification, ...newFields } = current;
  assert(same(oldFields, newFields), 'compatibility artifact or contract identity changed');
  assert(same(Object.fromEntries(Object.entries(oldSources).filter(([, value]) => value !== 'external')), newSources), 'only external source relationship removal allowed');
}

export function checkGovernance() {
  const env = json('governance/environment.json');
  validateEnvironment(env);
  assert(git('rev-parse', `${env.baseline.commit}^{tree}`) === env.baseline.tree, 'baseline tree mismatch');
  git('merge-base', '--is-ancestor', env.baseline.commit, 'HEAD');
  const paths = [...new Set([
    ...git('diff', '--name-only', env.baseline.commit, '--').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean))];
  validateChangedPaths(paths);
  validatePackageChange(JSON.parse(baselineFile(env.baseline.commit, 'package.json')), json('package.json'));
  validateBoundary(env);
  const development = json('compatibility/viewer-core.json').developmentQualification;
  if (development) {
    validateSourceBinding(development);
    validateQualificationReport(development);
  }
  const agents = read('AGENTS.md');
  for (const required of ['governance/adoption.md', 'governance/environment.json', 'hosted-public', 'full-integration', 'release/X.Y.Z', 'Mapping completion', 'HOLD', ...Object.keys(commands)]) assert(agents.includes(required), 'root working contract missing required boundary');
  const surfaces = checkPublicSurface();
  return { result: 'PASS', scope: 'focused-governance-only', baseline: env.baseline, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), workingTreeDigest: sha256(JSON.stringify(paths.sort().map((path) => [path, sha256(read(path))]))), commandSetDigest: sha256(JSON.stringify([...Object.values(commands), 'node scripts/document-governance.mjs validate'])), executor: 'local', node: process.version, changedPaths: paths, publicSurfaces: surfaces, effective: false, releaseReadiness: 'HOLD', productChanges: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(checkGovernance(), null, 2)); }
  catch (error) { console.error(error.message.startsWith('HOLD:') ? error.message : 'HOLD: governance input could not be read or verified safely'); process.exitCode = 1; }
}
