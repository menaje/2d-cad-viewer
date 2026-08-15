import assert from "node:assert/strict";
import test from "node:test";

import {
  drawOrderSurfaceFor,
  encodedDrawOrderColor,
  resizeDrawOrderSurface,
} from "../src/draw-order-overlay.mjs";
import { MAX_GLOBAL_MASK_BUCKET } from "../src/mask-order.mjs";

function makeCanvas() {
  const calls = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    filter: "none",
    setTransform(...values) {
      calls.push(["setTransform", ...values]);
    },
    clearRect(...values) {
      calls.push(["clearRect", ...values]);
    },
  };
  const orderCanvas = {
    width: 1,
    height: 1,
    getContext(name) {
      return name === "2d" ? context : null;
    },
  };
  return {
    canvas: {
      ownerDocument: {
        createElement(name) {
          return name === "canvas" ? orderCanvas : null;
        },
      },
    },
    context,
    orderCanvas,
    calls,
  };
}

test("encodes a draw-order bucket into a lossless RGB value", () => {
  assert.equal(encodedDrawOrderColor(0), "rgb(1, 0, 0)");
  assert.equal(encodedDrawOrderColor(0.5), "rgb(1, 1, 0)");
  assert.equal(encodedDrawOrderColor(255), "rgb(1, 254, 1)");
  assert.equal(encodedDrawOrderColor(10_000), "rgb(1, 32, 78)");
});

test("encodes the maximum supported draw-order bucket without RGB overflow", () => {
  assert.equal(
    encodedDrawOrderColor(MAX_GLOBAL_MASK_BUCKET),
    "rgb(1, 254, 255)",
  );
});

test("forces order-map drawing to opaque source-over colors", () => {
  const { canvas, context, orderCanvas, calls } = makeCanvas();
  const surface = drawOrderSurfaceFor(canvas);

  surface.setBucket(255);
  surface.proxy.fillStyle = "rgba(1, 2, 3, 0.1)";
  surface.proxy.strokeStyle = "transparent";
  surface.proxy.globalAlpha = 0.1;
  surface.proxy.filter = "blur(5px)";

  assert.equal(context.fillStyle, "rgb(1, 254, 1)");
  assert.equal(context.strokeStyle, "rgb(1, 254, 1)");
  assert.equal(context.globalAlpha, 1);
  assert.equal(context.filter, "none");
  assert.equal(
    resizeDrawOrderSurface(surface, 20, 10, { clear: true }),
    true,
  );
  assert.equal(orderCanvas.width, 20);
  assert.equal(orderCanvas.height, 10);
  assert.deepEqual(calls.at(-1), ["clearRect", 0, 0, 20, 10]);
});
