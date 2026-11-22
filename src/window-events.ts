import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

export async function listenWindow<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return listen(event, handler, { target: getCurrentWindow().label });
}
