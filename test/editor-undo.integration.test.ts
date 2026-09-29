import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorTheme } from "@earendil-works/pi-tui";

const identity = (text: string) => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

describe("installed Pi editor replacement integration", () => {
  it("records programmatic replacement as one native undo step", () => {
    const editor = new Editor({ requestRender: vi.fn() } as never, theme);
    editor.setText("original draft");
    editor.setText("improved draft");

    editor.handleInput("\x1f"); // Native tui.editor.undo (Ctrl+-)

    expect(editor.getExpandedText()).toBe("original draft");
  });
});
