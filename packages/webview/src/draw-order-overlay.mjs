import {
  DRAW_ORDER_SUBDIVISIONS,
  MAX_GLOBAL_MASK_BUCKET,
} from "./mask-order.mjs";

const ORDER_SURFACES = new WeakMap();

function createCanvasLike(canvas, width = 1, height = 1) {
  let result = null;
  if (typeof globalThis.OffscreenCanvas === "function") {
    result = new globalThis.OffscreenCanvas(width, height);
  } else {
    result = canvas?.ownerDocument?.createElement?.("canvas") ?? null;
    if (result) {
      result.width = width;
      result.height = height;
    }
  }
  return result;
}

export function encodedDrawOrderColor(bucket) {
  if (
    !Number.isFinite(bucket) ||
    bucket < 0 ||
    bucket > MAX_GLOBAL_MASK_BUCKET
  ) {
    throw new RangeError("draw-order bucket is outside the supported range");
  }
  const encoded = Math.round(bucket * DRAW_ORDER_SUBDIVISIONS) + 1;
  return `rgb(${encoded & 0xff}, ${(encoded >>> 8) & 0xff}, ${(encoded >>> 16) & 0xff})`;
}

function forcedOrderContext(context) {
  const state = {
    color: encodedDrawOrderColor(0),
  };
  const apply = () => {
    context.fillStyle = state.color;
    context.strokeStyle = state.color;
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
  };
  const proxy = new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "fillStyle" || property === "strokeStyle") {
        Reflect.set(target, property, state.color, target);
        return true;
      }
      if (property === "globalAlpha") {
        Reflect.set(target, property, 1, target);
        return true;
      }
      if (property === "filter") {
        Reflect.set(target, property, "none", target);
        return true;
      }
      if (property === "globalCompositeOperation") {
        Reflect.set(target, property, "source-over", target);
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
  return Object.freeze({
    context,
    proxy,
    setBucket(bucket) {
      state.color = encodedDrawOrderColor(bucket);
      apply();
      return state.color;
    },
  });
}

export function drawOrderSurfaceFor(canvas) {
  if (!canvas || (typeof canvas !== "object" && typeof canvas !== "function")) {
    return null;
  }
  if (ORDER_SURFACES.has(canvas)) {
    return ORDER_SURFACES.get(canvas);
  }
  const orderCanvas = createCanvasLike(canvas);
  const context = orderCanvas?.getContext?.("2d", { alpha: true }) ?? null;
  const surface =
    orderCanvas && context
      ? Object.freeze({
          canvas: orderCanvas,
          ...forcedOrderContext(context),
        })
      : null;
  ORDER_SURFACES.set(canvas, surface);
  return surface;
}

export function resizeDrawOrderSurface(surface, width, height, { clear = true } = {}) {
  if (!surface) {
    return false;
  }
  if (surface.canvas.width !== width || surface.canvas.height !== height) {
    surface.canvas.width = width;
    surface.canvas.height = height;
  }
  surface.context.setTransform(1, 0, 0, 1, 0, 0);
  surface.context.globalAlpha = 1;
  surface.context.globalCompositeOperation = "source-over";
  surface.context.filter = "none";
  if (clear) {
    surface.context.clearRect(0, 0, width, height);
  }
  return true;
}

export function createDrawOrderScratch(canvas, width = 1, height = 1) {
  const scratch = createCanvasLike(canvas, width, height);
  const context = scratch?.getContext?.("2d", { alpha: true }) ?? null;
  return scratch && context
    ? Object.freeze({ canvas: scratch, context })
    : null;
}
