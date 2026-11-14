import React from "react";
import {createRoot} from "react-dom/client";
import {App} from "./app/App.jsx";
import {ErrorBoundary} from "./components/ui.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <ErrorBoundary><App/></ErrorBoundary>
);
