// Minimal React stub — enough to execute the component tree synchronously and
// collect rendered text. Hooks are backed by a per-render cursor; effects and
// refs are inert, which is fine: the harness renders once, statically.
let hookState = [];
let hookCursor = 0;
let rootSeed = null;   // values to pre-load into the FIRST component's useState slots
let atRoot = false;
let seenRootComponent = false;
export function __resetHooks() { hookState = []; hookCursor = 0; rootSeed = null; atRoot = false; seenRootComponent = false; }
export function __seedRootState(values) { rootSeed = values || null; }

export function useState(init) {
  const i = hookCursor++;
  if (!(i in hookState)) {
    const seeded = atRoot && rootSeed && rootSeed[i] !== null && rootSeed[i] !== undefined;
    hookState[i] = seeded ? rootSeed[i] : (typeof init === "function" ? init() : init);
  }
  return [hookState[i], v => { hookState[i] = typeof v === "function" ? v(hookState[i]) : v; }];
}
let memoTap = null;
export function __tapMemo(fn) { memoTap = fn; }
export function useMemo(fn) {
  const i = hookCursor++;
  if (!(i in hookState)) { hookState[i] = fn(); if (memoTap) memoTap(hookState[i]); }
  return hookState[i];
}
export function useEffect() {}
export function useRef(init) { const i = hookCursor++; if (!(i in hookState)) hookState[i] = { current: init ?? null }; return hookState[i]; }

export function createElement(type, props, ...children) {
  return { $$el: true, type, props: props || {}, children: children.flat(Infinity) };
}
export const Fragment = Symbol("Fragment");

/** Depth-first evaluation: call every function component, flatten to text. */
export function renderToText(node, depth = 0) {
  if (depth > 500) throw new Error("render depth exceeded — likely a cycle");
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(n => renderToText(n, depth + 1)).join("");
  if (node.$$el) {
    const { type, props, children } = node;
    if (typeof type === "function") {
      const saveState = hookState, saveCursor = hookCursor, saveAtRoot = atRoot;
      hookState = []; hookCursor = 0;
      atRoot = !seenRootComponent;
      seenRootComponent = true;
      try {
        const out = type({ ...props, children: children.length === 1 ? children[0] : children });
        return renderToText(out, depth + 1);
      } finally { hookState = saveState; hookCursor = saveCursor; atRoot = saveAtRoot; }
    }
    const inner = [props?.children, ...children];
    return inner.map(n => renderToText(n, depth + 1)).join(" ");
  }
  if (node.props || node.children) return renderToText([node.props?.children, node.children], depth + 1);
  return "";
}

export default { createElement, Fragment, useState, useMemo, useEffect, useRef, renderToText, __resetHooks };
