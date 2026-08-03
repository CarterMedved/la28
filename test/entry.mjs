// Bundle entry: re-export the app plus the SAME react-stub instance the app
// was bundled against. The harness must drive that instance's hook state —
// importing the stub separately would create a second copy and seeding it
// would do nothing (which is exactly what happened first try).
export { Explorer, normalise } from "../qualification-app.jsx";
export * as ReactStub from "react";
