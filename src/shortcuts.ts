import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export const IMPROVE_SHORTCUTS = [
  "super+i",
  "ctrl+shift+i",
] as const satisfies readonly KeyId[];

export function matchesImproveShortcut(data: string): boolean {
  return IMPROVE_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}
