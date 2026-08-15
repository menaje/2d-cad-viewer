// SPDX-License-Identifier: MPL-2.0

import {
  SectionKind,
  TextEntityKind,
} from "@menaje/dwg-scene-source";

import {
  blockExternalReferenceIsDisplayable,
} from "./external-reference.mjs?v=1.26.0";
import {
  effectiveFrameSetting,
} from "./frame-setting.mjs?v=1.26.0";
import {
  annotativeTextRecordForInstance,
  textRecordIsVisible,
} from "./text-overlay.mjs?v=1.26.0";
import {
  makeViewDescriptors,
} from "./viewer.mjs?v=1.26.0";

export const PACKAGED_DISPLAY_STATE_OBSERVATION_SCHEMA =
  "dwg-packaged-display-state-observation/1";
export const PACKAGED_DISPLAY_STATE_RESULT_GLOBAL =
  "__dwgPackagedDisplayStateQualificationResult";
const CACHE_SCHEMA = "dwg-scene-cache/1.26";
const ENTITY_SECTION_KINDS = Object.freeze([
  SectionKind.Lines,
  SectionKind.Arcs,
  SectionKind.Circles,
  SectionKind.Inserts,
  SectionKind.PolylineHeaders,
  SectionKind.Ellipses,
  SectionKind.SplineHeaders,
  SectionKind.TextEntities,
  SectionKind.HatchEntities,
  SectionKind.PointEntities,
  SectionKind.SolidEntities,
  SectionKind.FaceEntities,
  SectionKind.WipeoutEntities,
  SectionKind.ImageEntities,
  SectionKind.ConstructionLines,
]);
const DEFERRED_REASONS = Object.freeze({
  unresolvedDimensions: 0,
  unsupportedUnderlays: 0,
  unsupportedProxyGraphics: 0,
  unsupported3dEntities: 0,
  invalidSupportedEntities: 0,
  unsupportedOtherEntities: 0,
});

function inventory(reader) {
  const serializedEntities = ENTITY_SECTION_KINDS.reduce(
    (total, kind) => total + reader.getSection(kind).recordCount,
    0,
  );
  return Object.freeze({
    sourceEntities: serializedEntities,
    serializedEntities,
    deferredEntities: 0,
    deferredReasons: DEFERRED_REASONS,
  });
}

function attributeDisplayDecision(mode) {
  const common = {
    commonFlags: 0,
    kind: TextEntityKind.Attribute,
  };
  return Object.freeze({
    normal: textRecordIsVisible(
      { ...common, sourceFlags: 0 },
      0,
      new Set([0]),
      mode,
    ),
    invisible: textRecordIsVisible(
      { ...common, sourceFlags: 1 },
      0,
      new Set([0]),
      mode,
    ),
  });
}

function annotationDisplayDecision(allVisible) {
  const record = Object.freeze({
    flags: 1 << 2,
    annotationContexts: Object.freeze([
      Object.freeze({ scale: 1, isDefault: true }),
    ]),
  });
  const selected = annotativeTextRecordForInstance(
    record,
    {
      annotationScalesByVisibilityRow: new Float64Array([2]),
    },
    { visibilityRows: new Uint32Array([0]) },
    0,
    allVisible,
  );
  return Object.freeze({
    missingScaleRepresentationVisible: selected !== null,
  });
}

function frameDisplayDecision(frame, specific) {
  const effective = effectiveFrameSetting(frame, specific);
  return Object.freeze({
    effective,
    screenVisible: effective === 1 || effective === 2,
    plotVisible: effective === 1,
  });
}

function xrefState(block) {
  if (!block) {
    return "missing";
  }
  if (block.xrefLoaded === false) {
    return "unloaded";
  }
  return block.xrefResolved === false ? "unresolved" : "loaded";
}

export function observePackagedDisplayState(scene) {
  if (!scene?.reader || !scene?.metadata) {
    throw new TypeError("display-state observation requires an open scene");
  }
  const metadata = scene.metadata;
  const views = makeViewDescriptors(metadata);
  const modelView = views.views.find((view) => view.kind === "model");
  const layoutView = views.views.find((view) => view.kind === "layout");
  if (!modelView || !layoutView) {
    throw new Error("display-state observation requires model and layout views");
  }
  const xref = metadata.blocks.find((value) => value.xrefPath);
  return Object.freeze({
    schema: PACKAGED_DISPLAY_STATE_OBSERVATION_SCHEMA,
    cacheSchema: CACHE_SCHEMA,
    inventory: inventory(scene.reader),
    display: Object.freeze({
      FILLMODE: Object.freeze({
        hatchFillVisible: metadata.drawing.fillMode,
      }),
      ATTMODE: attributeDisplayDecision(
        metadata.drawing.attributeDisplayMode,
      ),
      annotation: Object.freeze({
        model: annotationDisplayDecision(
          modelView.annotationAllVisible,
        ),
        layout: annotationDisplayDecision(
          layoutView.annotationAllVisible,
        ),
      }),
      FRAME: frameDisplayDecision(
        metadata.drawing.frame,
        metadata.drawing.imageFrame,
      ),
      layout: Object.freeze({
        activeKind: views.active.kind,
        restoration: views.savedStateRestoration.status,
      }),
      XREF: Object.freeze({
        state: xrefState(xref),
        displayable: Boolean(
          xref && blockExternalReferenceIsDisplayable(xref),
        ),
      }),
    }),
  });
}
