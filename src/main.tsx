import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary, logCrash } from "./ErrorBoundary";

// Leave a trace of otherwise-silent failures in latency.log.
let errCount = 0;
window.addEventListener("error", (e) => {
  if (errCount++ < 50) logCrash("window", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  if (errCount++ < 50) logCrash("promise", e.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary where="app" retryMs={1500}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
