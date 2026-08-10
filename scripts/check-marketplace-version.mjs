import { pathToFileURL } from "node:url";

const PRE_RELEASE_PROPERTY = "Microsoft.VisualStudio.Code.PreRelease";
const GALLERY_QUERY =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

export function analyzeMarketplaceVersion(
  response,
  extensionId,
  version,
  desiredChannel,
) {
  const extensions = response.results?.flatMap((result) => result.extensions ?? []) ?? [];
  const extension = extensions.find((candidate) => {
    const id = `${candidate.publisher?.publisherName}.${candidate.extensionName}`;
    return id.toLowerCase() === extensionId.toLowerCase();
  });
  if (!extension) {
    return { existingTargets: [], exists: false };
  }

  const matchingVersions = (extension.versions ?? []).filter(
    (candidate) => candidate.version === version,
  );
  const desiredPrerelease = desiredChannel === "prerelease";
  for (const candidate of matchingVersions) {
    const actualPrerelease =
      candidate.properties?.some(
        (property) =>
          property.key === PRE_RELEASE_PROPERTY && property.value === "true",
      ) ?? false;
    if (actualPrerelease !== desiredPrerelease) {
      throw new Error(
        `${extensionId} ${version} already exists in the ${
          actualPrerelease ? "prerelease" : "stable"
        } channel`,
      );
    }
  }

  return {
    existingTargets: matchingVersions.map(
      (candidate) => candidate.targetPlatform ?? "universal",
    ),
    exists: matchingVersions.length > 0,
  };
}

export async function queryMarketplaceVersion(
  extensionId,
  version,
  desiredChannel,
) {
  if (!new Set(["prerelease", "stable"]).has(desiredChannel)) {
    throw new Error(`unsupported Marketplace channel: ${desiredChannel}`);
  }
  const response = await fetch(GALLERY_QUERY, {
    body: JSON.stringify({
      assetTypes: [],
      filters: [
        {
          criteria: [{ filterType: 7, value: extensionId }],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      flags: 273,
    }),
    headers: {
      Accept: "application/json;api-version=7.2-preview.1",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Marketplace query failed for ${extensionId}: ${response.status} ${response.statusText}`,
    );
  }
  return analyzeMarketplaceVersion(
    await response.json(),
    extensionId,
    version,
    desiredChannel,
  );
}

async function main() {
  const [, , extensionId, version, desiredChannel] = process.argv;
  if (!extensionId || !version || !desiredChannel) {
    throw new Error(
      "usage: node scripts/check-marketplace-version.mjs <extension-id> <version> <prerelease|stable>",
    );
  }
  const result = await queryMarketplaceVersion(
    extensionId,
    version,
    desiredChannel,
  );
  process.stdout.write(
    result.exists
      ? `${extensionId} ${version} already has ${desiredChannel} target(s): ${result.existingTargets.join(", ")}\n`
      : `${extensionId} ${version} is available in ${desiredChannel}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
