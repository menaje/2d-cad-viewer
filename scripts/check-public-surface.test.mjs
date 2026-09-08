import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSurface, checkPublicSurface, repositoryPath } from './check-public-surface.mjs';

// Every invented name and hash here is synthetic, never copied from another product.
for (const [name, path, text, rule] of [
  ['unreviewed link', 'docs/example.md', 'https://github.com/example/hidden-project/issues/7', 'unreviewed-repository-link'],
  ['API backlink', 'governance/example.json', '{"origin":"https://api.github.com/repos/example/hidden-project/commits/abc"}', 'unreviewed-repository-link'],
  ['escaped backlink', 'docs/example.json', '{"origin":"https:\\/\\/github.com\\/example\\/hidden-project"}', 'unreviewed-repository-link'],
  ['local path', 'docs/example.md', 'source: /Users/example/project', 'local-provenance-path'],
  ['sibling authority', 'docs/example.md', 'authority: ../example/policy.md', 'sibling-provenance'],
  ['structured visibility', 'governance/generated/example.json', '{"documents":[{"visibility":"internal"}]}', 'nonpublic-visibility'],
  ['structured provenance', 'governance/example.json', '{"privateRevision":"0000000000000000000000000000000000000000"}', 'nonpublic-provenance-field'],
  ['named relationship', 'docs/example.md', 'Example Engine owns revision authority.', 'undeclared-actor-role'],
  ['Korean relationship', 'docs/example.md', 'Example Engine은 호환 package를 사용한다.', 'undeclared-actor-role'],
  ['named service', 'docs/example.md', '`ExampleServiceSource` owns the source.', 'undeclared-service-implementation'],
  ['source relationship', 'compatibility/example.json', '{"sources":{"exampleService":"external"}}', 'external-source-relationship'],
  ['unverified consumer', 'governance/example.json', '{"consumers":{"example":{"role":"owner"}}}', 'unverified-product-relationship'],
  ['escaping Markdown link', 'docs/example.md', '[source](../../outside/policy.md)', 'escaping-document-link'],
  ['metadata sibling path', 'governance/example.json', '{"sourcePath":"../example/policy.md"}', 'nonlocal-metadata-path'],
  ['external authority', 'governance/generated/example.json', '{"externalDocuments":[{"id":"EXAMPLE-POLICY"}]}', 'external-authority'],
]) test(`rejects ${name} without echoing payload`, () => {
  const findings = inspectSurface(path, text);
  assert.ok(findings.some((finding) => finding.rule === rule));
  assert.deepEqual(Object.keys(findings[0]), ['path', 'rule']);
});

test('preserves public identities, package privacy and geometric terms', () => {
  assert.deepEqual(inspectSurface('docs/example.md', 'CONI-VIEWER-ARCHITECTURE @menaje/viewer-core RenderProtocolVersion SPATIAL_FILTER INSERT/XREF spatial clips. Viewer Core owns lifecycle. https://github.com/menaje/2d-cad-viewer'), []);
  assert.deepEqual(inspectSurface('package.json', '{"private":true,"version":"0.1.8"}'), []);
});
test('scans untracked generated metadata and rejects symlink escape', () => {
  const base = mkdtempSync(join(tmpdir(), 'viewer-surface-test-'));
  try {
    execFileSync('git', ['init', '-q', base]);
    mkdirSync(join(base, 'generated'));
    writeFileSync(join(base, 'generated', 'example.json'), '{"visibility":"private"}');
    assert.throws(() => checkPublicSurface(base), /nonpublic-visibility/);
    symlinkSync(tmpdir(), join(base, 'linked'));
    assert.throws(() => repositoryPath('linked/example.md', base), /symbolic/);
    assert.throws(() => repositoryPath('../outside.md', base), /escapes/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
