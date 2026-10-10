import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredTheme } from "./theme";
import "./index.css";

applyStoredTheme();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
const url = new URL(window.location.href);
const loginToken = url.searchParams.get("token");
if (loginToken !== null) {
  url.searchParams.delete("token");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

createRoot(container).render(
  <StrictMode>
    <App loginToken={loginToken} />
  </StrictMode>,
);
