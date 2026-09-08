import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = resolve(import.meta.dirname, '..');
// Positive public identity inventory, observed public on 2026-09-08.
// Changes require public visibility evidence; never add a non-public denylist.
const publicRepositories = new Set([
  'ChristopherVR/emf-converter', 'DomCR/ACadSharp', 'LibreDWG/libredwg',
  'dotnet/core', 'mapbox/earcut', 'menaje/2d-cad-viewer',
  'menaje/bim-explorer', 'mlightcad/shx-parser', 'pkgconf/pkgconf',
].map((value) => value.toLowerCase()));
const publicActors = new Set([
  'Viewer', 'Viewer Core', 'Viewer UI', 'Viewer WebGL', 'BIM Explorer',
  'Core', 'Host', 'Service', 'Render', 'VS Code', 'DWG', 'WebGL',
  'LibreDWG', 'Browser', 'RenderSource', 'ViewerHost', 'Source',
  'VSIX', 'Native Document Adapter',
]);

export function repositoryPath(path, base = root) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path)) {
    throw new Error('HOLD: invalid repository-local path');
  }
  const full = resolve(base, path);
  if (relative(base, full) !== path || path.split('/').includes('..')) {
    throw new Error('HOLD: path escapes repository');
  }
  // Reject symlink traversal even when its textual path is repository-local.
  let current = base;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('HOLD: symbolic surface path');
  }
  return full;
}

export function surfacePaths(base = root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: base, encoding: 'utf8' }).split('\0').filter((path) => /\.(md|json|ya?ml)$/iu.test(path)))].sort();
}

export function inspectSurface(path, text) {
  const problems = new Set();
  const add = (rule) => problems.add(rule);
  const normalized = text.normalize('NFKC').replaceAll('\\/', '/');
  for (const match of normalized.matchAll(/(?:https?:\/\/(?:github\.com|api\.github\.com\/repos|raw\.githubusercontent\.com)\/|git@github\.com:)([\w.-]+\/[\w.-]+)/giu)) {
    if (!publicRepositories.has(match[1].replace(/\.git$/u, '').toLowerCase())) add('unreviewed-repository-link');
  }
  if (/(?:file:\/\/|\/(?:Users|Volumes|home)\/|[A-Z]:\\(?:Users|work)\\)/u.test(normalized)) add('local-provenance-path');
  if (/(?:source|origin|authority|repository|provenance)\s*[:=]\s*[`"']?\.\.\//iu.test(normalized)) add('sibling-provenance');
  if (/(?:https?:\/\/[^\s]*\.internal\b|\b(?:private|internal)[-_](?:repository|product|revision|digest|origin|backlink)\s*[:=])/iu.test(normalized)) add('nonpublic-provenance');
  // Match actor/role syntax rather than a list of non-public product names.
  for (const match of normalized.matchAll(/\b([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*){0,2})\s+(?:owns|consumes|embeds|Workspace|Protocol|permission code|code\.)/gu)) {
    if (!publicActors.has(match[1])) add('undeclared-actor-role');
  }
  for (const match of normalized.matchAll(/\b([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*){0,2})(?:은|는|의|도)\s+(?:renderer|standalone|호환|BIM|Agent|Workspace|Canonical|제품|권한)/gu)) {
    if (!publicActors.has(match[1])) add('undeclared-actor-role');
  }
  for (const match of normalized.matchAll(/\b([A-Z][A-Za-z]*ServiceSource)\b/gu)) {
    if (match[1] !== 'MockServiceSource') add('undeclared-service-implementation');
  }
  for (const match of normalized.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/iu.test(target)) continue;
    let decoded;
    try { decoded = decodeURIComponent(target); } catch { add('invalid-link'); continue; }
    const local = posix.normalize(posix.join(posix.dirname(path), decoded));
    if (local === '..' || local.startsWith('../') || posix.isAbsolute(decoded)) add('escaping-document-link');
  }
  if (/\.json$/iu.test(path)) {
    let data;
    try { data = JSON.parse(text); } catch { add('invalid-json'); }
    function visit(value, pointer = '') {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        const next = `${pointer}/${key}`;
        if (/^(?:visibility|sourceVisibility|repositoryVisibility)$/iu.test(key) && item !== 'public') add('nonpublic-visibility');
        if (/^(?:private|internal)(?:Repository|Product|Revision|Digest|Origin|Backlink)$/u.test(key)) add('nonpublic-provenance-field');
        if (/^(?:repository|ownerRepository)$/u.test(key) && typeof item === 'string' && item.includes('/') && !publicRepositories.has(item.replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').toLowerCase())) add('unreviewed-repository-field');
        if (/^(?:path|sourcePath|originPath|authorityPath)$/u.test(key) && typeof item === 'string' && (item.startsWith('../') || item.startsWith('/') || item.includes('\\'))) add('nonlocal-metadata-path');
        // Source registries describe local conformance only, never named external products.
        if (pointer === '/sources' && item === 'external') add('external-source-relationship');
        if (key === 'externalDocuments' && (!Array.isArray(item) || item.length !== 0)) add('external-authority');
        if (/^(?:consumers|producers)$/u.test(key) && item && typeof item === 'object') {
          for (const entry of Object.values(item)) {
            const repo = typeof entry === 'object' && entry?.repository;
            if (typeof repo !== 'string' || !repo.startsWith('https://github.com/')) add('unverified-product-relationship');
          }
        }
        visit(item, next);
      }
    }
    visit(data);
  }
  return [...problems].map((rule) => ({ path, rule }));
}

export function checkPublicSurface(base = root) {
  const paths = surfacePaths(base);
  const problems = paths.flatMap((path) => inspectSurface(path, readFileSync(repositoryPath(path, base), 'utf8')));
  if (problems.length) {
    // Never print matched content, identifiers, revisions or backlinks.
    throw new Error(`HOLD: public surface review required\n${problems.map(({ path, rule }) => `${path}: ${rule}`).join('\n')}`);
  }
  return paths.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`public surface valid: ${checkPublicSurface()} files; contextual review still required`); }
  catch (error) { console.error(error.message.startsWith('HOLD:') ? error.message : 'HOLD: public surface input could not be read safely'); process.exitCode = 1; }
}
