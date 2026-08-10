import {
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

export const MAX_XREF_SEARCH_ROOTS = 32;
export const DEFAULT_XREF_SEARCH_DEPTH = 8;
export const MAX_XREF_SEARCH_ENTRIES = 50_000;
export const MAX_XREF_CANDIDATES = 256;

export interface XrefManualMappings {
  exact?: Readonly<Record<string, string>>;
  basenames?: Readonly<Record<string, string>>;
  prefixes?: Readonly<Record<string, string>>;
}

export interface ResolveXrefOptions {
  drawingPath: string;
  storedPath: string;
  searchRoots?: readonly string[];
  mappings?: XrefManualMappings;
  maximumDepth?: number;
  maximumEntries?: number;
  signal?: AbortSignal;
}

export interface XrefCandidate {
  path: string;
  matchedTrailingSegments: number;
}

export type XrefResolution =
  | {
      status: "resolved";
      path: string;
      method:
        | "manual-exact"
        | "manual-basename"
        | "manual-prefix"
        | "stored"
        | "relative"
        | "search";
      candidates: readonly XrefCandidate[];
      searchTruncated: boolean;
    }
  | {
      status: "ambiguous" | "missing";
      candidates: readonly XrefCandidate[];
      searchTruncated: boolean;
    };

function comparisonKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function splitPortablePath(value: string): string[] {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  const unc = /^\/{2}/u.test(normalized);
  const driveAbsolute = /^[A-Za-z]:\//u.test(normalized);
  const rooted = unc || driveAbsolute || /^\//u.test(normalized);
  const withoutPrefix = driveAbsolute
    ? normalized.slice(3)
    : normalized.replace(/^\/+/u, "");
  const result: string[] = [];
  const rootFloor = unc ? 2 : 0;
  for (const segment of withoutPrefix.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (
        result.length > rootFloor &&
        result.at(-1) !== ".."
      ) {
        result.pop();
      } else if (!rooted) {
        result.push(segment);
      }
      continue;
    }
    result.push(segment);
  }
  return result;
}

export function normalizePortablePath(value: string): string {
  const input = value.trim().normalize("NFC");
  const unc = /^[\\/]{2}/u.test(input);
  const drive = input
    .replaceAll("\\", "/")
    .match(/^[A-Za-z]:\//u)?.[0]
    .slice(0, 2)
    .toUpperCase();
  const segments = splitPortablePath(input);
  const body = segments.join("/");
  if (unc) {
    return `//${body}`;
  }
  if (drive) {
    return `${drive}/${body}`;
  }
  if (/^[\\/]/u.test(input)) {
    return `/${body}`;
  }
  return body;
}

export function xrefExactMappingKey(
  drawingPath: string,
  storedPath: string,
): string {
  return `${comparisonKey(path.resolve(drawingPath))}\0${comparisonKey(
    normalizePortablePath(storedPath),
  )}`;
}

export function xrefBasename(storedPath: string): string {
  const segments = splitPortablePath(storedPath);
  const filename = segments.at(-1) ?? "";
  return comparisonKey(
    path.extname(filename) ? filename : `${filename}.dwg`,
  );
}

function isPortableAbsolute(value: string): boolean {
  return (
    path.posix.isAbsolute(value.replaceAll("\\", "/")) ||
    path.win32.isAbsolute(value)
  );
}

async function existingFile(candidate: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate)) {
    return undefined;
  }
  try {
    const metadata = await stat(candidate);
    return metadata.isFile() ? path.resolve(candidate) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function currentPlatformStoredPath(storedPath: string): string | undefined {
  if (process.platform === "win32" && path.win32.isAbsolute(storedPath)) {
    return path.win32.normalize(storedPath);
  }
  if (process.platform !== "win32" && path.posix.isAbsolute(storedPath)) {
    return path.posix.normalize(storedPath);
  }
  return undefined;
}

function deduplicateRoots(values: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!path.isAbsolute(value)) {
      continue;
    }
    const resolved = path.resolve(value);
    const key =
      process.platform === "win32"
        ? comparisonKey(resolved)
        : resolved.normalize("NFC");
    if (!seen.has(key) && roots.length < MAX_XREF_SEARCH_ROOTS) {
      seen.add(key);
      roots.push(resolved);
    }
  }
  return roots;
}

function localPathKey(value: string): string {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32"
    ? comparisonKey(resolved)
    : resolved;
}

function trailingMatchCount(candidatePath: string, storedPath: string): number {
  const candidate = splitPortablePath(candidatePath).map(comparisonKey);
  const stored = splitPortablePath(storedPath).map(comparisonKey);
  if (candidate.length === 0 || stored.length === 0) {
    return 0;
  }
  const candidateName = candidate.at(-1) ?? "";
  let storedName = stored.at(-1) ?? "";
  if (!path.extname(storedName)) {
    storedName += ".dwg";
  }
  if (candidateName !== storedName) {
    return 0;
  }
  let matches = 1;
  while (
    matches < candidate.length &&
    matches < stored.length &&
    candidate[candidate.length - 1 - matches] ===
      stored[stored.length - 1 - matches]
  ) {
    matches += 1;
  }
  return matches;
}

async function searchByBasename(
  roots: readonly string[],
  storedPath: string,
  {
    maximumDepth,
    maximumEntries,
    signal,
  }: Required<Pick<ResolveXrefOptions, "maximumDepth" | "maximumEntries">> & {
    signal?: AbortSignal;
  },
): Promise<{
  candidates: XrefCandidate[];
  truncated: boolean;
}> {
  const targetName = xrefBasename(storedPath);
  const candidates: XrefCandidate[] = [];
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  let visitedEntries = 0;
  let truncated = false;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (
      truncated ||
      signal?.aborted ||
      depth > maximumDepth
    ) {
      return;
    }
    let canonicalDirectory;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      return;
    }
    const directoryKey = localPathKey(canonicalDirectory);
    if (seenDirectories.has(directoryKey)) {
      return;
    }
    seenDirectories.add(directoryKey);
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (signal?.aborted) {
          return;
        }
        visitedEntries += 1;
        if (visitedEntries > maximumEntries) {
          truncated = true;
          return;
        }
        const candidatePath = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await visit(candidatePath, depth + 1);
        } else if (
          entry.isFile() &&
          comparisonKey(entry.name) === targetName
        ) {
          const resolved = path.resolve(candidatePath);
          const key = localPathKey(resolved);
          if (!seenFiles.has(key)) {
            seenFiles.add(key);
            candidates.push({
              path: resolved,
              matchedTrailingSegments: trailingMatchCount(
                resolved,
                storedPath,
              ),
            });
          }
          if (candidates.length >= MAX_XREF_CANDIDATES) {
            truncated = true;
            return;
          }
        }
      }
    } catch {
      // A directory can disappear or become unreadable during bounded search.
    }
  };

  for (const root of roots) {
    await visit(root, 0);
    if (truncated || signal?.aborted) {
      break;
    }
  }
  candidates.sort(
    (left, right) =>
      right.matchedTrailingSegments - left.matchedTrailingSegments ||
      comparisonKey(left.path).localeCompare(comparisonKey(right.path)),
  );
  return { candidates, truncated };
}

async function nearbyBasenameCandidates(
  directories: readonly string[],
  storedPath: string,
  signal?: AbortSignal,
): Promise<XrefCandidate[]> {
  const targetName = xrefBasename(storedPath);
  const candidates: XrefCandidate[] = [];
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  for (const directory of deduplicateRoots(directories)) {
    if (signal?.aborted) {
      break;
    }
    let canonicalDirectory;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      continue;
    }
    const directoryKey = localPathKey(canonicalDirectory);
    if (seenDirectories.has(directoryKey)) {
      continue;
    }
    seenDirectories.add(directoryKey);
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }
    try {
      for await (const entry of handle) {
        if (signal?.aborted) {
          break;
        }
        if (
          !entry.isFile() ||
          comparisonKey(entry.name) !== targetName
        ) {
          continue;
        }
        const resolved = path.resolve(directory, entry.name);
        const key = localPathKey(resolved);
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          candidates.push({
            path: resolved,
            matchedTrailingSegments: trailingMatchCount(
              resolved,
              storedPath,
            ),
          });
        }
      }
    } catch {
      // A nearby directory can disappear while it is being inspected.
    }
  }
  return candidates.sort(
    (left, right) =>
      right.matchedTrailingSegments - left.matchedTrailingSegments ||
      comparisonKey(left.path).localeCompare(comparisonKey(right.path)),
  );
}

async function resolveMappedPath(
  candidate: string | undefined,
): Promise<string | undefined> {
  if (!candidate || !path.isAbsolute(candidate)) {
    return undefined;
  }
  return existingFile(candidate);
}

function prefixMappedPath(
  storedPath: string,
  prefixes: Readonly<Record<string, string>>,
): string | undefined {
  const normalized = normalizePortablePath(storedPath);
  const normalizedKey = comparisonKey(normalized);
  const matches = Object.entries(prefixes)
    .map(([source, destination]) => ({
      source: normalizePortablePath(source).replace(/\/+$/u, ""),
      destination,
    }))
    .filter(({ source, destination }) => {
      const key = comparisonKey(source);
      return (
        path.isAbsolute(destination) &&
        (normalizedKey === key || normalizedKey.startsWith(`${key}/`))
      );
    })
    .sort((left, right) => right.source.length - left.source.length);
  const best = matches[0];
  if (!best) {
    return undefined;
  }
  const remainder = normalized
    .slice(best.source.length)
    .replace(/^\/+/u, "");
  return path.join(best.destination, ...splitPortablePath(remainder));
}

export async function resolveXrefPath({
  drawingPath,
  storedPath,
  searchRoots = [],
  mappings = {},
  maximumDepth = DEFAULT_XREF_SEARCH_DEPTH,
  maximumEntries = MAX_XREF_SEARCH_ENTRIES,
  signal,
}: ResolveXrefOptions): Promise<XrefResolution> {
  if (!path.isAbsolute(drawingPath)) {
    throw new TypeError("drawing path must be absolute");
  }
  if (
    typeof storedPath !== "string" ||
    storedPath.length > 32_768
  ) {
    return { status: "missing", candidates: [], searchTruncated: false };
  }
  if (
    !Number.isSafeInteger(maximumDepth) ||
    maximumDepth < 0 ||
    maximumDepth > 32 ||
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries <= 0 ||
    maximumEntries > 1_000_000
  ) {
    throw new RangeError("invalid XREF search limits");
  }

  const exact = await resolveMappedPath(
    mappings.exact?.[xrefExactMappingKey(drawingPath, storedPath)],
  );
  if (exact) {
    return {
      status: "resolved",
      path: exact,
      method: "manual-exact",
      candidates: [],
      searchTruncated: false,
    };
  }
  if (storedPath.length === 0) {
    return { status: "missing", candidates: [], searchTruncated: false };
  }
  const basename = await resolveMappedPath(
    mappings.basenames?.[xrefBasename(storedPath)],
  );
  if (basename) {
    return {
      status: "resolved",
      path: basename,
      method: "manual-basename",
      candidates: [],
      searchTruncated: false,
    };
  }
  const prefix = await resolveMappedPath(
    prefixMappedPath(storedPath, mappings.prefixes ?? {}),
  );
  if (prefix) {
    return {
      status: "resolved",
      path: prefix,
      method: "manual-prefix",
      candidates: [],
      searchTruncated: false,
    };
  }

  const platformPath = currentPlatformStoredPath(storedPath);
  const stored = platformPath
    ? await existingFile(platformPath)
    : undefined;
  if (stored) {
    return {
      status: "resolved",
      path: stored,
      method: "stored",
      candidates: [],
      searchTruncated: false,
    };
  }

  if (!isPortableAbsolute(storedPath)) {
    const relative = await existingFile(
      path.join(
        path.dirname(drawingPath),
        ...splitPortablePath(storedPath),
      ),
    );
    if (relative) {
      return {
        status: "resolved",
        path: relative,
        method: "relative",
        candidates: [],
        searchTruncated: false,
      };
    }
  }

  const drawingDirectory = path.dirname(drawingPath);
  const nearby = await nearbyBasenameCandidates(
    [path.join(drawingDirectory, "xref"), drawingDirectory],
    storedPath,
    signal,
  );
  if (nearby.length === 1) {
    return {
      status: "resolved",
      path: nearby[0].path,
      method: "search",
      candidates: nearby,
      searchTruncated: false,
    };
  }
  if (nearby.length > 1) {
    return {
      status: "ambiguous",
      candidates: nearby,
      searchTruncated: false,
    };
  }
  const roots = deduplicateRoots([
    path.join(drawingDirectory, "xref"),
    drawingDirectory,
    ...searchRoots,
  ]);
  const search = await searchByBasename(roots, storedPath, {
    maximumDepth,
    maximumEntries,
    signal,
  });
  const bestScore = search.candidates[0]?.matchedTrailingSegments ?? 0;
  const best = search.candidates.filter(
    (candidate) => candidate.matchedTrailingSegments === bestScore,
  );
  if (best.length === 1) {
    return {
      status: "resolved",
      path: best[0].path,
      method: "search",
      candidates: search.candidates,
      searchTruncated: search.truncated,
    };
  }
  return {
    status: best.length > 1 ? "ambiguous" : "missing",
    candidates: search.candidates,
    searchTruncated: search.truncated,
  };
}
