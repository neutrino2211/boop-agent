import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import "./styles.css";

const storedTheme = (() => {
  try {
    return localStorage.getItem("boop-debug-theme");
  } catch {
    return null;
  }
})();
document.documentElement.classList.add(storedTheme === "light" ? "light" : "dark");

async function resolveConvexUrl(): Promise<string> {
  const fromBuildEnv = import.meta.env.VITE_CONVEX_URL?.trim();
  if (fromBuildEnv) return fromBuildEnv;
  try {
    const response = await fetch("/api/debug/config");
    if (!response.ok) return "";
    const payload = (await response.json()) as { convexUrl?: unknown };
    return typeof payload.convexUrl === "string" ? payload.convexUrl.trim() : "";
  } catch {
    return "";
  }
}

async function bootstrap() {
  const convexUrl = await resolveConvexUrl();
  if (!convexUrl) {
    document.getElementById("root")!.innerHTML = `
      <div style="padding:2rem;font-family:system-ui">
        <h1>Convex URL is not set</h1>
        <p>Set <code>CONVEX_URL</code> (or <code>VITE_CONVEX_URL</code>) and reload.</p>
      </div>`;
    return;
  }

  const convex = new ConvexReactClient(convexUrl);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ConvexProvider client={convex}>
          <App />
        </ConvexProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
