import React from "react";

interface StatusBarProps {
  currentFile: string;
  nodeCount: number;
  edgeCount: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  currentFile,
  nodeCount,
  edgeCount,
}) => {
  return (
    <div className="statusbar">
      <span className="statusbar-file" title={currentFile}>
        {currentFile}
      </span>
      <span className="statusbar-stats">
        {nodeCount} files, {edgeCount} connections
      </span>
    </div>
  );
};
