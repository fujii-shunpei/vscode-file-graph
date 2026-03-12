import { useCallback, useEffect, useState } from "react";
import type { GraphData } from "../types/graph";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    __INITIAL_DATA__?: GraphData;
  }
}

const vscode = typeof acquireVsCodeApi === "function"
  ? acquireVsCodeApi()
  : null;

export function useVsCode() {
  const [graphData, setGraphData] = useState<GraphData | null>(
    window.__INITIAL_DATA__ ?? null,
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.command === "updateGraph") {
        setGraphData(message.data);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const openFile = useCallback((filePath: string) => {
    vscode?.postMessage({ command: "openFile", filePath });
  }, []);

  const setDepth = useCallback((depth: number) => {
    vscode?.postMessage({ command: "setDepth", depth });
  }, []);

  return { graphData, openFile, setDepth };
}
