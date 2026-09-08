import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeNpmPackageArchive } from './normalize-npm-package-archive.mjs';

const root = resolve(import.meta.dirname, '..');
export const baselineRevision = 'b955e9cda3e24bfa4dd9f6fd3597f1aa1d6a5ccb';
export const packageDefinitions = Object.freeze([
  { key: 'viewerCore', directory: 'packages/viewer-core' },
  { key: 'renderProtocol', directory: 'packages/render-protocol' },
  { key: 'viewerUi', directory: 'packages/viewer-ui' },
]);
export const evidencePath = 'compatibility/evidence/viewer-boundary-development-environment.json';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const same = (a, b) => assert.deepEqual(a, b);
const exactRevision = (revision) => assert.match(revision ?? '', /^[a-f0-9]{40}$/u, 'exact source revision required');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && command.endsWith('.cmd') });
const git = (...args) => run('git', args).trim();
const gitBytes = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

const manifestTestPath = 'packages/viewer-core/test/viewer-core.test.mjs';
const sourcePaths = new Set([
  manifestTestPath,
  'AGENTS.md', 'package.json', 'compatibility/README.md', 'compatibility/viewer-core.json',
  'docs/architecture.md', 'docs/adr/ADR-0001-viewer-core-boundary.md',
  'governance/README.md', 'governance/adoption.md', 'governance/environment.json',
  'governance/public-boundary-corrections.json', 'governance/governed-documents.json',
  'governance/document-generation.json', 'governance/generated/document-catalog.json',
  'governance/generated/document-export.public.json',
  'scripts/check-governance.mjs', 'scripts/check-governance.test.mjs',
  'scripts/check-public-surface.mjs', 'scripts/check-public-surface.test.mjs',
  'scripts/development-package-evidence.mjs', 'scripts/development-package-evidence.test.mjs',
  'scripts/qualify-viewer-boundary.mjs',
  ...packageDefinitions.map(({ directory }) => `${directory}/README.md`),
]);
const evidenceOnlyPaths = new Set([
  'compatibility/viewer-core.json', evidencePath, 'governance/environment.json',
  'governance/public-boundary-corrections.json', 'governance/document-generation.json',
  'governance/generated/document-catalog.json', 'governance/generated/document-export.public.json',
]);
export function validateChangePaths(paths, { evidenceOnly = false } = {}) {
  const allowed = evidenceOnly ? evidenceOnlyPaths : sourcePaths;
  assert.ok(paths.length > 0, 'exact nonempty change classification required');
  for (const path of paths) assert.ok(allowed.has(path), 'change exceeds environment/documentation-only scope');
}
export function validateArtifactRecords(artifacts, historical) {
  same(Object.keys(artifacts).sort(), packageDefinitions.map(({ key }) => key).sort());
  for (const { key } of packageDefinitions) {
    const item = artifacts[key];
    same(Object.keys(item).sort(), ['file', 'sha256', 'bytes', 'contentSha256'].sort());
    assert.equal(item.file, historical[key].file, 'package/version identity must remain unchanged');
    for (const field of ['sha256', 'contentSha256']) assert.match(item[field] ?? '', /^[a-f0-9]{64}$/u, 'exact artifact digest required');
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0, 'positive exact artifact size required');
  }
}
export function validateCompatibilityPreservation(before, after) {
  const { developmentQualification: ignored, sources: priorSources, ...previous } = before;
  const { developmentQualification: development, sources: currentSources, ...current } = after;
  same(current, previous);
  same(currentSources, Object.fromEntries(Object.entries(priorSources).filter(([, value]) => value !== 'external')));
  return development;
}
export function validateRootMetadata(before, after) {
  const { scripts: oldScripts, ...oldMetadata } = before;
  const { scripts: newScripts, ...newMetadata } = after;
  same(newMetadata, oldMetadata);
  for (const [key, value] of Object.entries(oldScripts)) assert.equal(newScripts[key], value, 'existing package behavior cannot change');
  const added = Object.keys(newScripts).filter((key) => !Object.hasOwn(oldScripts, key));
  const expected = {
    'check:governance': 'node scripts/check-governance.mjs',
    'test:governance': 'node --test scripts/check-governance.test.mjs scripts/check-public-surface.test.mjs',
    'check:public-surface': 'node scripts/check-public-surface.mjs',
    'check:development-artifacts': 'node scripts/development-package-evidence.mjs verify',
    'test:development-artifacts': 'node --test scripts/development-package-evidence.test.mjs',
  };
  same(added.sort(), Object.keys(expected).sort());
  for (const [key, command] of Object.entries(expected)) assert.equal(newScripts[key], command, 'only focused script additions allowed');
}
export function validatePackageFiles(baseFiles, sourceFiles) {
  same(sourceFiles.filter(({ path }) => !path.endsWith('/README.md') && path !== manifestTestPath), baseFiles.filter(({ path }) => !path.endsWith('/README.md') && path !== manifestTestPath));
}
export function compareMeasuredArtifacts(actual, expected) { same(actual, expected); }
export function validateQualifierChange(before, after) {
  const expected = before.replace('const repositoryRoot = path.resolve(', 'import { validateSourceBinding, validateQualificationReport } from "./development-package-evidence.mjs";\n\nconst repositoryRoot = path.resolve(')
    .replace('if (developmentActive) {\n  assert.equal(developmentQualification.status, "passed");', 'if (developmentActive) {\n  validateSourceBinding(developmentQualification, { allowEvidenceWorktree: emitOnly });\n  if (!emitOnly) validateQualificationReport(developmentQualification);\n  assert.equal(developmentQualification.status, "passed");');
  assert.equal(after, expected, 'only the development evidence guard may change the qualifier');
}
export function validateManifestTestChange(before, after) {
  const expected = before.replace('  assert.equal(manifest.developmentQualification, undefined);', `  if (manifest.developmentQualification !== undefined) {
    const { validateSourceBinding, validateQualificationReport } = await import(
      "../../../scripts/development-package-evidence.mjs"
    );
    validateSourceBinding(manifest.developmentQualification);
    validateQualificationReport(manifest.developmentQualification);
  }`);
  assert.equal(after, expected, 'only the non-payload manifest governance assertion may change');
}
function trackedFiles(revision, directories) {
  return git('ls-tree', '-r', revision, '--', ...directories).split('\n').filter(Boolean).map((line) => {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    assert.ok(match, 'only regular tracked package files allowed');
    assert.equal(match[1], '100644', 'package symlinks or executable payload change forbidden');
    return { mode: match[1], blob: match[2], path: match[3] };
  });
}
function sourceChanges(revision) {
  return git('diff', '--name-status', '--no-renames', baselineRevision, revision).split('\n').filter(Boolean).map((line) => {
    const [status, path] = line.split('\t');
    assert.ok(['A', 'M'].includes(status), 'source deletions or renames require separate review');
    return { path, status, classification: path === manifestTestPath ? 'non-payload-manifest-governance-test' : path.startsWith('packages/') ? 'package-readme-only' : 'governance-environment-only', sourceBlob: git('rev-parse', `${revision}:${path}`) };
  });
}
function ensureHistory(revision) {
  exactRevision(revision);
  // Hosted checkout may be shallow. Fetch only exact public Git inputs; never
  // change a branch, workflow, tag or release to obtain validation evidence.
  const available = () => {
    try {
      git('cat-file', '-e', `${baselineRevision}^{commit}`);
      git('cat-file', '-e', `${revision}^{commit}`);
      git('merge-base', '--is-ancestor', revision, 'HEAD');
      return true;
    } catch { return false; }
  };
  if (available()) return;
  assert.match(git('remote', 'get-url', 'origin'), /^https:\/\/github\.com\/menaje\/2d-cad-viewer(?:\.git)?$/u, 'exact public repository required for missing inputs');
  run('git', ['fetch', '--no-tags', '--depth=32', 'origin', git('rev-parse', 'HEAD'), revision, baselineRevision]);
  assert.ok(available(), 'exact source ancestry unavailable: HOLD');
}
export function validateSourceBinding(development, { allowEvidenceWorktree = false } = {}) {
  exactRevision(development.sourceRevision);
  assert.equal(development.classification, 'environment-documentation-only');
  assert.equal(development.baselineRevision, baselineRevision);
  assert.equal(development.publishedInDistribution, false);
  assert.equal(development.feature, 'environment-documentation-repack');
  assert.equal(development.sourceVersion, '0.1.3');
  assert.equal(development.command, 'pnpm run qualify:viewer-boundary');
  assert.equal(development.evidence, evidencePath);
  assert.equal(development.releaseReadiness, 'HOLD');
  ensureHistory(development.sourceRevision);
  assert.equal(git('rev-parse', `${development.sourceRevision}^{tree}`), development.sourceTree, 'source tree mismatch');
  const sourceManifest = JSON.parse(gitBytes(development.sourceRevision, 'compatibility/viewer-core.json'));
  assert.equal(sourceManifest.developmentQualification, undefined, 'source must precede its artifact evidence; circular binding forbidden');
  const historical = JSON.parse(gitBytes(baselineRevision, 'compatibility/viewer-core.json'));
  validateCompatibilityPreservation(historical, sourceManifest);
  validateCompatibilityPreservation(historical, readJson(join(root, 'compatibility/viewer-core.json')));
  validateQualifierChange(gitBytes(baselineRevision, 'scripts/qualify-viewer-boundary.mjs').toString('utf8'), gitBytes(development.sourceRevision, 'scripts/qualify-viewer-boundary.mjs').toString('utf8'));
  validateManifestTestChange(gitBytes(baselineRevision, manifestTestPath).toString('utf8'), gitBytes(development.sourceRevision, manifestTestPath).toString('utf8'));
  const changes = sourceChanges(development.sourceRevision);
  validateChangePaths(changes.map(({ path }) => path));
  same(development.sourceChanges, changes);
  const directories = packageDefinitions.map(({ directory }) => directory);
  const sourceFiles = trackedFiles(development.sourceRevision, directories);
  const baseFiles = trackedFiles(baselineRevision, directories);
  validatePackageFiles(baseFiles, sourceFiles);
  assert.equal(digest(JSON.stringify(sourceFiles)), development.packageSourceDigest, 'package source digest mismatch');
  for (const item of sourceFiles) {
    same(readFileSync(join(root, item.path)), gitBytes(development.sourceRevision, item.path));
  }
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...directories), '', 'dirty/untracked package input forbidden');
  validateRootMetadata(JSON.parse(gitBytes(baselineRevision, 'package.json')), JSON.parse(gitBytes(development.sourceRevision, 'package.json')));
  validateRootMetadata(JSON.parse(gitBytes(baselineRevision, 'package.json')), readJson(join(root, 'package.json')));
  const afterSource = [...new Set([...git('diff', '--name-only', development.sourceRevision, '--').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  if (afterSource.length) validateChangePaths(afterSource, { evidenceOnly: true });
  if (!allowEvidenceWorktree) assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'committed evidence inputs required');
  validateArtifactRecords(development.artifacts, historical.distribution.artifacts);
  return historical;
}
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert.ok(entry.isDirectory() || entry.isFile(), 'archive link or unsupported payload type');
    return entry.isDirectory() ? filesBelow(path) : [path];
  }).sort();
}
export async function measureArtifacts(destination) {
  mkdirSync(destination, { recursive: true });
  const artifacts = {};
  const source = readJson(join(root, 'compatibility/viewer-core.json'));
  for (const definition of packageDefinitions) {
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', definition.directory, 'pack', '--pack-destination', destination]);
    const file = source.distribution.artifacts[definition.key].file;
    const archive = join(destination, file);
    await normalizeNpmPackageArchive(archive);
    const entries = run('tar', ['-tzf', archive]).trim().split(/\r?\n/u);
    assert.ok(entries.every((entry) => /^package\/(?:src\/[^.][^\r\n]*|package\.json|README\.md|LICENSE|NOTICE)$/u.test(entry) && !entry.split('/').includes('..')), 'unexpected package payload');
    const extracted = join(destination, definition.key);
    mkdirSync(extracted);
    run('tar', ['-xzf', archive, '-C', extracted]);
    const content = createHash('sha256');
    const packageRoot = join(extracted, 'package');
    for (const path of filesBelow(packageRoot)) {
      const relative = path.slice(packageRoot.length + 1).replaceAll('\\', '/');
      const bytes = readFileSync(path);
      content.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
      if (relative !== 'package.json') same(bytes, readFileSync(join(root, definition.directory, relative)));
    }
    const packed = readJson(join(packageRoot, 'package.json'));
    const original = readJson(join(root, definition.directory, 'package.json'));
    const expected = structuredClone(original);
    for (const [dependency, version] of Object.entries(expected.dependencies ?? {})) {
      const workspace = /^workspace:([*^~])$/u.exec(version);
      if (workspace) {
        const target = packageDefinitions.find(({ directory }) => readJson(join(root, directory, 'package.json')).name === dependency);
        assert.ok(target, 'unknown workspace dependency');
        expected.dependencies[dependency] = (workspace[1] === '*' ? '' : workspace[1]) + readJson(join(root, target.directory, 'package.json')).version;
      }
    }
    same(packed, expected);
    const bytes = readFileSync(archive);
    artifacts[definition.key] = { file, sha256: digest(bytes), bytes: bytes.length, contentSha256: content.digest('hex') };
  }
  return artifacts;
}
export async function verifyArtifacts(development, options = {}) {
  validateSourceBinding(development, options);
  const temporary = mkdtempSync(join(tmpdir(), 'viewer-development-verify-'));
  try {
    const actual = await measureArtifacts(join(temporary, 'first'));
    compareMeasuredArtifacts(actual, development.artifacts);
    const repeated = await measureArtifacts(join(temporary, 'repeat'));
    same(repeated, actual);
    for (const { key } of packageDefinitions) same(readFileSync(join(temporary, 'first', actual[key].file)), readFileSync(join(temporary, 'repeat', actual[key].file)));
    return actual;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function validateQualificationReport(development, bytes = readFileSync(join(root, evidencePath))) {
  assert.equal(development.status, 'passed');
  assert.equal(digest(bytes), development.evidenceSha256, 'exact qualification report digest mismatch');
  const report = JSON.parse(bytes);
  assert.equal(report.sourceRevision, development.sourceRevision);
  assert.equal(report.sourceTree, development.sourceTree);
  assert.equal(report.report.status, 'passed-viewer-owned-development-boundary');
  for (const { key } of packageDefinitions) {
    const item = report.report.artifacts[key];
    for (const field of ['file', 'sha256', 'bytes', 'contentSha256']) assert.equal(item[field], development.artifacts[key][field]);
    assert.equal(item.publishedInDistribution, false);
    assert.equal(item.runnerRepackByteIdentical, true);
  }
  assert.equal(report.report.scope.deploymentPerformed, false);
  assert.equal(report.report.artifactOnlyConsumer.conformance.stagedAtomicGeometryPickCommit, true);
}

async function main() {
  const [command, sourceRevision, output] = process.argv.slice(2);
  if (command === 'measure') {
    exactRevision(sourceRevision);
    assert.equal(git('rev-parse', 'HEAD'), sourceRevision, 'measure exact committed source only');
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'clean source required');
    assert.ok(output && !resolve(output).startsWith(`${root}/`), 'artifact output must be outside repository');
    const artifacts = await measureArtifacts(join(resolve(output), 'first'));
    same(await measureArtifacts(join(resolve(output), 'repeat')), artifacts);
    const sourceFiles = trackedFiles(sourceRevision, packageDefinitions.map(({ directory }) => directory));
    const record = { status: 'measured', publishedInDistribution: false, sourceVersion: '0.1.3', feature: 'environment-documentation-repack', classification: 'environment-documentation-only', command: 'pnpm run qualify:viewer-boundary', baselineRevision, sourceRevision, sourceTree: git('rev-parse', `${sourceRevision}^{tree}`), sourceChanges: sourceChanges(sourceRevision), packageSourceDigest: digest(JSON.stringify(sourceFiles)), evidence: evidencePath, releaseReadiness: 'HOLD', artifacts };
    validateSourceBinding(record);
    writeFileSync(join(resolve(output), 'measurement.json'), `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'measured-not-published', sourceRevision, artifacts }, null, 2));
  } else if (command === 'verify' && sourceRevision === undefined) {
    const development = readJson(join(root, 'compatibility/viewer-core.json')).developmentQualification;
    assert.ok(development, 'missing development evidence: HOLD');
    await verifyArtifacts(development);
    validateQualificationReport(development);
    console.log('development artifact evidence valid: 3 packages, 2 identical packs, exact source, historical distribution unchanged; release HOLD');
  } else throw new Error('use measure <exact-source-revision> <external-output-directory> or verify');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('HOLD: development artifact evidence validation failed'); process.exitCode = 1; });
}
