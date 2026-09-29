import extension from "../index.js";

const shortcuts: string[] = [];
const commands: string[] = [];
extension(
  {
    registerShortcut(key: string) {
      shortcuts.push(key);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as never,
  { homeDirectory: "/tmp/pi-prompt-improve-smoke" },
);
if (shortcuts.join(",") !== "super+i,ctrl+shift+i")
  throw new Error("shortcut registration failed");
if (commands.join(",") !== "prompt-improve")
  throw new Error("command registration failed");
console.log("Prompt Improver extension loaded");
