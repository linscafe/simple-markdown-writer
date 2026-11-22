export async function readText(): Promise<string> {
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return readText();
}

export async function writeText(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  return writeText(text);
}
