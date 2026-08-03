// jsx-runtime shim over the React stub, for esbuild's automatic JSX transform.
import { createElement, Fragment } from "./react.js";
const toEl = (type, props = {}) => {
  const { children, ...rest } = props || {};
  const kids = children === undefined ? [] : Array.isArray(children) ? children : [children];
  return createElement(type, rest, ...kids);
};
export const jsx = toEl;
export const jsxs = toEl;
export { Fragment };
