// The harness feeds the app pre-parsed data, so the app's XLSX import only
// needs to exist. parseWorkbook is never called in the render test.
export const read = () => { throw new Error("stub: not used in render test"); };
export const utils = { sheet_to_json: () => { throw new Error("stub"); } };
export default { read, utils };
