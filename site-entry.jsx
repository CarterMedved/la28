/**
 * Production mount point — the ONLY file that touches the DOM. The app
 * itself stays environment-agnostic (harnesses execute it with a stub
 * React; this file is never imported by any test entry).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./qualification-app.jsx";

createRoot(document.getElementById("root")).render(<App />);
