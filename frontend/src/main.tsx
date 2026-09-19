import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted Roboto, weight axis only: one file covers 100–900 and includes
// latin-ext, which is what Turkish ğ / ı / ş need. Shipping it with the bundle
// keeps the first paint free of a third-party font round trip.
import "@fontsource-variable/roboto/wght.css";
import "@fontsource-variable/roboto-mono/wght.css";
import "./index.css";
import App from "./App.tsx";

const rootElement = document.getElementById("root") as HTMLElement;
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
