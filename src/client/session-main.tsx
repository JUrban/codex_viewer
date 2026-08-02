import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionApp } from "./SessionApp";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(
  <StrictMode>
    <SessionApp />
  </StrictMode>,
);
