import { useCallback, useEffect, useState } from "react";
import type { GraphPayload } from "../types/graph";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    __INITIAL_DATA__?: GraphPayload;
  }
}

const vscode = typeof acquireVsCodeApi === "function"
  ? acquireVsCodeApi()
  : null;

export function useVsCode() {
  const [graphPayload, setGraphPayload] = useState<GraphPayload | null>(
    window.__INITIAL_DATA__ ?? null,
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.command === "updateGraph") {
        setGraphPayload(message.data);
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

  return { graphPayload, openFile, setDepth };
}
