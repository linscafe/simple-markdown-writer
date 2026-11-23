import { invoke } from "@tauri-apps/api/core";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import type { UserConfig } from "./settings";

export function zoomBindings(keys: UserConfig["keymap"], zoom: (step: number) => void): KeyBinding[] {
  const steps: [string[], number][] = [[keys.zoom_in, 1], [keys.zoom_out, -1], [keys.zoom_reset, 0]];
  return steps.flatMap(([list, step]) => list.map((key) => ({ key, run: () => { zoom(step); return true; } })));
}

export function zoomExtension(context: { config?: UserConfig }): Extension {
  const keys = context.config?.keymap;
  if (!keys) return [];
  return Prec.highest(keymap.of(zoomBindings(keys, (step) => { void invoke("zoom", { step }).catch(console.error); })));
}
