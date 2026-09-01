import * as assert from "assert";
import * as vscode from "vscode";

suite("Test harness smoke", () => {
  test("runs inside a VS Code extension host", () => {
    assert.ok(vscode.version.length > 0);
  });
});
