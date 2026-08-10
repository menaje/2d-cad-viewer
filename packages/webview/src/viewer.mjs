import { buildInstanceGraph } from "./instance-graph.mjs?v=1.21.3";
import { layerLinetypeCodes } from "./cad-linetype.mjs";
import {
  buildLayoutInstanceGraph,
  paperViewportForLayout,
} from "./layout-scene.mjs?v=1.21.0";
import { readJsHeapSnapshot } from "./memory-telemetry.mjs";
import { calculateRasterImageBounds } from "./raster-image-overlay.mjs";
import { WebGlLineRenderer } from "./renderer.mjs?v=1.21.0";
import { SceneCacheReader } from "./scene-cache.mjs?v=1.21.0";

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteBounds(bounds) {
  return (
    bounds?.min?.length === 3 &&
    bounds?.max?.length === 3 &&
    bounds.min.every(Number.isFinite) &&
    bounds.max.every(Number.isFinite) &&
    bounds.min.every((value, axis) => value <= bounds.max[axis]) &&
    bounds.min.every((value) => Math.abs(value) < 1e18) &&
    bounds.max.every((value) => Math.abs(value) < 1e18)
  );
}

function layoutPreferredBounds(layout) {
  if (finiteBounds(layout.extents)) {
    return layout.extents;
  }
  const limits = {
    min: [layout.limits.min[0], layout.limits.min[1], 0],
    max: [layout.limits.max[0], layout.limits.max[1], 0],
  };
  if (finiteBounds(limits)) {
    return Object.freeze({
      min: Object.freeze(limits.min),
      max: Object.freeze(limits.max),
    });
  }
  return null;
}

function layoutPreferredView(layout) {
  const viewport = paperViewportForLayout(layout);
  if (
    !viewport ||
    !Array.isArray(viewport.viewCenter) ||
    !viewport.viewCenter.every(Number.isFinite) ||
    !Number.isFinite(viewport.viewHeight) ||
    viewport.viewHeight <= 0
  ) {
    return null;
  }
  return Object.freeze({
    center: Object.freeze([
      viewport.viewCenter[0],
      viewport.viewCenter[1],
      viewport.center[2] ?? 0,
    ]),
    height: viewport.viewHeight,
    width:
      Number.isFinite(viewport.width) && viewport.width > 0
        ? viewport.width
        : viewport.viewHeight,
    twist: Number.isFinite(viewport.viewTwist)
      ? viewport.viewTwist
      : 0,
  });
}

function makeViewDescriptors(metadata) {
  const orderedLayouts = [...metadata.layouts].sort(
    (left, right) => left.tabOrder - right.tabOrder,
  );
  const modelLayout =
    orderedLayouts.find(
      (layout) =>
        metadata.blocks[layout.blockIndex]?.name.toUpperCase() ===
        "*MODEL_SPACE",
    ) ?? null;
  const views = [
    Object.freeze({
      id: "model",
      kind: "model",
      label: modelLayout?.name || "Model",
      layout: modelLayout,
      preferredBounds: null,
      preferredView: metadata.drawing.savedModelView,
    }),
    ...orderedLayouts
      .filter((layout) => layout !== modelLayout)
      .map((layout) =>
        Object.freeze({
          id: `layout:${layout.index}`,
          kind: "layout",
          label: layout.name || `Layout ${layout.tabOrder}`,
          layout,
          preferredBounds: layoutPreferredBounds(layout),
          preferredView: layoutPreferredView(layout),
        }),
      ),
  ];
  const active =
    metadata.drawing.modelSpaceActive || views.length === 1
      ? views[0]
      : views.find((view) => view.kind === "layout") ?? views[0];
  return Object.freeze({
    views: Object.freeze(views),
    active,
  });
}

function buildViewInstanceGraph(
  metadata,
  layerLineTypes,
  view,
  options = {},
) {
  const common = {
    layers: metadata.layers,
    insertClips: metadata.insertClips,
    layerLinetypeCodes: layerLineTypes,
    paperSpaceLinetypeScale:
      metadata.drawing.paperSpaceLinetypeScale,
    ...options,
  };
  return view.kind === "layout"
    ? buildLayoutInstanceGraph(
        metadata.blocks,
        metadata.inserts,
        metadata.layers,
        view.layout,
        common,
      )
    : buildInstanceGraph(metadata.blocks, metadata.inserts, common);
}

export function createDisposableFirstFrameScene(input) {
  let state = input;
  const value = (key) => state?.[key];
  const requireState = () => {
    if (state) {
      return state;
    }
    const error = new Error("first-frame scene is disposed");
    error.name = "AbortError";
    throw error;
  };
  return Object.freeze({
    get reader() {
      return value("reader");
    },
    get metadata() {
      return value("metadata");
    },
    get instanceGraph() {
      return value("instanceGraph");
    },
    get overview() {
      return value("overview");
    },
    get imageEntities() {
      return value("imageEntities");
    },
    get embeddedImages() {
      return value("embeddedImages");
    },
    get renderer() {
      return value("renderer");
    },
    get render() {
      return value("render");
    },
    get metrics() {
      return value("metrics");
    },
    get views() {
      return value("views");
    },
    get activeView() {
      return value("activeView");
    },
    buildViewInstanceGraph(view, options) {
      const current = requireState();
      return buildViewInstanceGraph(
        current.metadata,
        current.layerLineTypes,
        view,
        options,
      );
    },
    dispose() {
      const current = state;
      state = undefined;
      current?.reader?.cache?.clear?.();
    },
  });
}

export async function loadFirstFrame(
  source,
  canvas,
  { onProgress = () => {}, renderer = new WebGlLineRenderer(canvas) } = {},
) {
  const started = now();
  onProgress("헤더와 섹션 목록 읽는 중");
  const reader = await SceneCacheReader.open(source);
  const openedAt = now();

  onProgress("레이어·블록·배치 정보 읽는 중");
  const metadata = await reader.readRenderMetadata();
  const metadataAt = now();

  onProgress("블록 인스턴스 구성 중");
  const layerLineTypes = layerLinetypeCodes(
    metadata.layers,
    metadata.linetypes,
  );
  const viewSet = makeViewDescriptors(metadata);
  const instanceGraph = buildViewInstanceGraph(
    metadata,
    layerLineTypes,
    viewSet.active,
  );
  const instancesAt = now();

  onProgress("첫 화면 4MiB 이하 버퍼 읽는 중");
  const [overview, imageEntities, embeddedImages] = await Promise.all([
    reader.readOverviewVertices(),
    reader.readImageEntities(),
    reader.readEmbeddedImages(),
  ]);
  const overviewAt = now();
  const imageBounds = imageEntities
    ? calculateRasterImageBounds({
        imageEntities,
        blocks: metadata.blocks,
        instanceGraph,
      })
    : null;

  onProgress("GPU 첫 화면 그리는 중");
  const render = renderer.renderOverview({
    batches: metadata.batches,
    layers: metadata.layers,
    blocks: metadata.blocks,
    instanceGraph,
    vertices: overview,
    lineWeightDisplay: metadata.drawing.lineWeightDisplay,
    linetypes: metadata.linetypes,
    layerLinetypeCodes: layerLineTypes,
    globalLinetypeScale: metadata.drawing.globalLinetypeScale,
    preferredBounds: viewSet.active.preferredBounds,
    preferredView: viewSet.active.preferredView,
    supplementalBounds: imageBounds,
  });
  const renderedAt = now();

  const metrics = Object.freeze({
    cacheVersion: `${reader.header.major}.${reader.header.minor}`,
    cacheBytes: reader.header.fileSize,
    sourceBytes: reader.header.sourceSize,
    preview: reader.header.preview,
    overviewBytes: overview.byteLength,
    blocks: metadata.blocks.length,
    inserts: metadata.inserts.length,
    instances: instanceGraph.instanceCount,
    batches: metadata.batches.length,
    timings: Object.freeze({
      openMs: openedAt - started,
      metadataMs: metadataAt - openedAt,
      instancesMs: instancesAt - metadataAt,
      overviewReadMs: overviewAt - instancesAt,
      renderMs: renderedAt - overviewAt,
      firstFrameMs: renderedAt - started,
    }),
    renderer: render,
    instanceDiagnostics: instanceGraph.diagnostics,
    memory: readJsHeapSnapshot(),
  });
  onProgress("첫 화면 완료");

  return createDisposableFirstFrameScene({
    reader,
    metadata,
    instanceGraph,
    overview,
    imageEntities,
    embeddedImages,
    renderer,
    render,
    metrics,
    views: viewSet.views,
    activeView: viewSet.active,
    layerLineTypes,
  });
}

export async function loadExternalFirstFrame(
  source,
  { onProgress = () => {} } = {},
) {
  onProgress("참조도면 헤더와 섹션 목록 읽는 중");
  const reader = await SceneCacheReader.open(source);
  onProgress("참조도면 레이어·블록·배치 정보 읽는 중");
  const metadata = await reader.readRenderMetadata();
  onProgress("참조도면 블록 인스턴스 구성 중");
  const layerLineTypes = layerLinetypeCodes(
    metadata.layers,
    metadata.linetypes,
  );
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
    {
      layers: metadata.layers,
      insertClips: metadata.insertClips,
      layerLinetypeCodes: layerLineTypes,
    },
  );
  onProgress("참조도면 첫 화면 버퍼 읽는 중");
  const [overview, imageEntities, embeddedImages] = await Promise.all([
    reader.readOverviewVertices(),
    reader.readImageEntities(),
    reader.readEmbeddedImages(),
  ]);
  return Object.freeze({
    reader,
    metadata,
    instanceGraph,
    overview,
    imageEntities,
    embeddedImages,
  });
}
