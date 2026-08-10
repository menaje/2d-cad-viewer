import { ViewerSelectionController } from "@menaje/viewer-core/selection";

import { WebGlLineRenderer } from "./renderer.mjs";

function requireContext(context) {
  if (
    !context ||
    typeof context !== "object" ||
    !context.sourceSession ||
    !context.snapshot ||
    !context.host
  ) {
    throw new TypeError(
      "Viewer WebGL presentation requires an open Viewer Core context",
    );
  }
  return context;
}

function requireCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError(
      "Viewer WebGL presentation requires a canvas",
    );
  }
  return canvas;
}

function requireScene(scene, renderer) {
  if (
    !scene ||
    typeof scene !== "object" ||
    scene.renderer !== renderer ||
    !scene.render
  ) {
    throw new TypeError(
      "Viewer WebGL loader must return a rendered scene",
    );
  }
  return scene;
}

export async function mountWebGlPresentation(
  inputContext,
  {
    canvas: inputCanvas,
    load,
    renderer: inputRenderer,
    projectSelection = null,
  } = {},
) {
  const context = requireContext(inputContext);
  const canvas = requireCanvas(inputCanvas);
  if (typeof load !== "function") {
    throw new TypeError(
      "Viewer WebGL presentation requires a scene loader",
    );
  }
  if (
    projectSelection !== null &&
    typeof projectSelection !== "function"
  ) {
    throw new TypeError(
      "Viewer WebGL selection projector must be a function",
    );
  }

  const renderer =
    inputRenderer ?? new WebGlLineRenderer(canvas);
  let scene;
  let selectionController;
  try {
    scene = requireScene(
      await load(
        Object.freeze({
          ...context,
          canvas,
          renderer,
        }),
      ),
      renderer,
    );
    selectionController =
      projectSelection === null
        ? null
        : new ViewerSelectionController({
            host: context.host,
            snapshot: context.snapshot,
            projectSelection,
          });
  } catch (error) {
    renderer.dispose();
    throw error;
  }

  let disposed = false;
  return Object.freeze({
    context,
    scene,
    renderer,
    selectionController,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      selectionController?.dispose();
      await scene.dispose?.();
      renderer.dispose();
    },
  });
}
