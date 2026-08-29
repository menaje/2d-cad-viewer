import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const revisionPattern = /^[a-f0-9]{40}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const idPattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const fields = new Set(['schemaVersion','documentId','title','type','version','status','normativity','authority','visibility','supersedes','lastReviewed','effectiveAt','extensions']);
const statuses = new Set(['draft','active','accepted','adopted','superseded','archived','deprecated','retired','historical']);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message) => { throw new Error(message); };

function localPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\')) fail(`invalid repository path: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).join('/') !== path) fail(`path escapes repository: ${path}`);
  return absolute;
}

function parseFrontMatter(bytes, path, owner) {
  const source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  if (!source.startsWith('---\n')) fail(`${path}: missing front matter`);
  const close = source.indexOf('\n---\n', 4);
  if (close < 0) fail(`${path}: unclosed front matter`);
  let metadata;
  try { metadata = JSON.parse(source.slice(4, close)); } catch { fail(`${path}: front matter must be one JSON object`); }
  for (const key of Object.keys(metadata)) if (!fields.has(key)) fail(`${path}: unknown metadata field ${key}`);
  for (const key of fields) if (!Object.hasOwn(metadata, key)) fail(`${path}: missing metadata field ${key}`);
  if (metadata.schemaVersion !== '1.1.0' || !idPattern.test(metadata.documentId) || !versionPattern.test(metadata.version)) fail(`${path}: invalid identity or version`);
  if (!statuses.has(metadata.status) || !['normative','informative'].includes(metadata.normativity) || !['public','internal','private'].includes(metadata.visibility)) fail(`${path}: invalid status or visibility`);
  if (!Array.isArray(metadata.authority) || metadata.authority.length === 0 || new Set(metadata.authority).size !== metadata.authority.length) fail(`${path}: authority must be unique and non-empty`);
  if (!metadata.authority.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item))) fail(`${path}: invalid authority identifier`);
  if (!Array.isArray(metadata.supersedes) || metadata.supersedes.includes(metadata.documentId) || !metadata.supersedes.every((item) => idPattern.test(item))) fail(`${path}: invalid supersession`);
  if (!datePattern.test(metadata.lastReviewed) || !datePattern.test(metadata.effectiveAt) || metadata.extensions?.repository !== owner || !metadata.extensions.documentRole) fail(`${path}: invalid dates or repository extension`);
  return { metadata, body: source.slice(close + 5) };
}

async function gitBytes(revision, path) {
  if (!revisionPattern.test(revision)) fail('exact 40-hex source revision required');
  try { return (await exec('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch { fail(`${path} is unavailable at ${revision}`); }
}

async function configuration() {
  const path = 'governance/governed-documents.json';
  const bytes = await readFile(localPath(path));
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== '1.0.0' || typeof value.ownerRepository !== 'string' || !Array.isArray(value.documents) || value.documents.length === 0 || value.externalDocuments?.length !== 0 || typeof value.publicProjection !== 'boolean') fail('invalid governed document configuration');
  return { path, bytes, value };
}

async function checkLinks(path, body) {
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/iu.test(target) || target.startsWith('#')) continue;
    const resolved = resolve(dirname(localPath(path)), decodeURI(target));
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`)) fail(`${path}: link escapes repository: ${target}`);
    try { await readFile(resolved); } catch { fail(`${path}: broken link: ${target}`); }
  }
}

async function build(sourceRevision) {
  const config = await configuration();
  if (!(await gitBytes(sourceRevision, config.path)).equals(config.bytes)) fail('governance configuration drifted from source revision');
  const paths = config.value.documents.map((entry) => entry.sourcePath);
  if (new Set(paths).size !== paths.length) fail('duplicate governed source path');
  const ids = new Set();
  const authorities = new Map();
  const documents = [];
  for (const sourcePath of paths) {
    const bytes = await readFile(localPath(sourcePath));
    if (!(await gitBytes(sourceRevision, sourcePath)).equals(bytes)) fail(`${sourcePath} drifted from source revision`);
    const { metadata, body } = parseFrontMatter(bytes, sourcePath, config.value.ownerRepository);
    await checkLinks(sourcePath, body);
    if (ids.has(metadata.documentId)) fail(`duplicate document ID: ${metadata.documentId}`);
    ids.add(metadata.documentId);
    for (const authority of metadata.authority) {
      if (authorities.has(authority)) fail(`authority conflict: ${authority}`);
      authorities.set(authority, metadata.documentId);
    }
    documents.push({ ...metadata, extensions: undefined, ownerRepository: config.value.ownerRepository, sourcePath, digest: digest(bytes), supersededBy: [] });
  }
  for (const record of documents) for (const target of record.supersedes) if (!ids.has(target)) fail(`${record.documentId}: dangling supersession ${target}`);
  documents.sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { config, catalog: { schemaVersion: '1.1.0', ownerRepository: config.value.ownerRepository, sourceRevision, documents, externalDocuments: [], generatorVersion: '1.1.0' } };
}

async function generate(sourceRevision) {
  const { config, catalog } = await build(sourceRevision);
  await mkdir(localPath('governance/generated'), { recursive: true });
  await writeFile(localPath('governance/generated/document-catalog.json'), serialize(catalog));
  const outputs = ['governance/generated/document-catalog.json'];
  if (config.value.publicProjection) {
    const exported = catalog.documents.filter((record) => record.visibility === 'public').map(({ supersededBy, ...record }) => record);
    const projection = { schemaVersion: '1.1.0', projection: 'public', ownerRepository: catalog.ownerRepository, sourceRevision, catalogDigest: digest(Buffer.from(serialize(catalog))), documents: exported, externalDocuments: [], generatorVersion: '1.1.0' };
    await writeFile(localPath('governance/generated/document-export.public.json'), serialize(projection));
    outputs.push('governance/generated/document-export.public.json');
  }
  await writeFile(localPath('governance/document-generation.json'), serialize({ schemaVersion: '1.0.0', sourceRevision, outputs }));
  console.log(`generated ${catalog.documents.length} governed document records`);
}

async function validate() {
  const generation = JSON.parse(await readFile(localPath('governance/document-generation.json')));
  if (generation.schemaVersion !== '1.0.0' || !revisionPattern.test(generation.sourceRevision) || !Array.isArray(generation.outputs)) fail('invalid document generation manifest');
  const { config, catalog } = await build(generation.sourceRevision);
  const expected = new Map([['governance/generated/document-catalog.json', serialize(catalog)]]);
  if (config.value.publicProjection) {
    const exported = catalog.documents.filter((record) => record.visibility === 'public').map(({ supersededBy, ...record }) => record);
    expected.set('governance/generated/document-export.public.json', serialize({ schemaVersion: '1.1.0', projection: 'public', ownerRepository: catalog.ownerRepository, sourceRevision: generation.sourceRevision, catalogDigest: digest(Buffer.from(serialize(catalog))), documents: exported, externalDocuments: [], generatorVersion: '1.1.0' }));
  }
  if (generation.outputs.length !== expected.size || generation.outputs.some((path) => !expected.has(path))) fail('generated output manifest mismatch');
  for (const [path, bytes] of expected) if ((await readFile(localPath(path), 'utf8')) !== bytes) fail(`${path}: generated drift`);
  console.log(`document governance valid: ${catalog.documents.length} records`);
}

const [command, sourceRevision] = process.argv.slice(2).filter((argument) => argument !== '--');
if (command === 'generate') await generate(sourceRevision);
else if (command === 'validate') await validate();
else fail('use generate <40-hex-source-revision> or validate');
