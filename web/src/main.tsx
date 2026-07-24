import React from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { store } from "./store";
import { App } from "./app/App";
import { applyTheme, getTheme } from "./theme";
import "./index.css";

applyTheme(getTheme()); // stamp the saved theme before first paint

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </Provider>
  </React.StrictMode>,
);

// Register the service worker (offline shell + web push). Only in production
// builds served over http(s); skipped under the Vite dev server.
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => { /* non-fatal */ });
  });
}
