import { invoke } from "@tauri-apps/api/core";
import { listenWindow } from "./window-events";
import { createEditor, parentDirectory } from "./editor";
import { writeFile } from "./fsapi";
import { isDirty, showMessage } from "./document";
import { installUserThemes, listThemes, setTheme } from "./theme";
import { applyConfig, persistEditorState, type AppState, type UserConfig } from "./settings";
import "./style.css";

interface InitialSession {
  doc: { path: string; content: string };
  config: UserConfig;
  state: AppState;
  themes: { name: string; css: string }[];
  timing: boolean;
}

const marks: [string, number][] = [["script start", performance.now()]];
const mark = (label: string) => { marks.push([label, performance.now()]); };

function timingMarks(): [string, number][] {
  const epoch = (at: number) => performance.timeOrigin + at;
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const page: [string, number][] = navigation ? [
    ["navigation start", 0], ["html received", navigation.responseEnd], ["dom interactive", navigation.domInteractive],
  ] : [];
  const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => /\.(js|css)$/.test(entry.name))
    .map((entry): [string, number] => [`loaded ${entry.name.split("/").pop()} (${Math.round(entry.duration)} ms)`, entry.responseEnd]);
  const editor = performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("mdw:") && entry.name !== "mdw:first-paint")
    .map((entry): [string, number] => [entry.name.slice(4), entry.startTime]);
  const all = [...page, ...resources, ...marks, ...editor].sort((a, b) => a[1] - b[1]);
  return all.map(([label, at]) => [`[js] ${label}`, epoch(at)]);
}

const warmUpSample = [
  "# Heading 1", "## Heading 2", "### Heading 3", "#### Heading 4", "",
  "Text with **bold**, *italic*, ***both***, ~~strike~~, `code`, [link](https://example.com) and $x^2$.", "",
  "> Quote", "", "- Bullet", "- [ ] Task", "- [x] Done", "1. First", "", "---", "",
  "| A | B |", "|:--|--:|", "| a | **b** |", "", "```ts", "const x = 1;", "```", "",
  "$$", "\\int_0^1 x\\,dx", "$$", "", "end",
].join("\n");

// A spare window renders a throwaway editor so code, styles and font faces are warm before a document arrives.
async function warmUp(parent: HTMLElement, assigned: Promise<InitialSession>): Promise<void> {
  setTheme("auto");
  const view = createEditor({
    parent, path: "/mdw-warm-up/warm-up.md", dir: "/mdw-warm-up", content: warmUpSample,
    writeFile: async () => {}, quit: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const warmed = new Promise<void>((resolve) => { timer = setTimeout(resolve, 50); });
    const session = await Promise.race([assigned, warmed]);
    if (!session) void view.contentDOM.offsetHeight;
  } finally {
    clearTimeout(timer);
    view.destroy();
  }
}

async function initialSession(parent: HTMLElement): Promise<InitialSession> {
  mark("invoke get_initial_session");
  const current = await invoke<InitialSession | null>("get_initial_session");
  if (current) return current;

  let assign!: (session: InitialSession) => void;
  const assigned = new Promise<InitialSession>((resolve) => { assign = resolve; });
  const unlisten = await listenWindow<InitialSession>("mdw-assign", ({ payload }) => assign(payload));
  try {
    // Assignment can race listener registration on the first (cold) request.
    // Rust either returns the assigned session or arms event delivery under the same lock.
    const pending = await Promise.race([
      assigned, invoke<InitialSession | null>("get_initial_session", { listening: true }),
    ]);
    if (pending) return pending;
    await warmUp(parent, assigned).catch(console.error);
    return await assigned;
  } finally {
    unlisten();
  }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>("#editor");
  if (!parent) throw new Error("Editor container is missing");

  try {
    const { doc, config, state, themes, timing } = await initialSession(parent);
    mark("session received");
    const shown = invoke("show_window");
    installUserThemes(themes);
    applyConfig(config);
    const preferredTheme = state.theme ?? config.theme;
    setTheme(listThemes().includes(preferredTheme) ? preferredTheme : "auto");
    mark("theme applied");
    const saveState = (snapshot: AppState, themeChanged: boolean) => invoke<void>("save_state", { state: snapshot, themeChanged });
    let persistence: ReturnType<typeof persistEditorState>;
    const view = createEditor({
      parent,
      ...doc,
      config,
      fileStates: state.files,
      beforeDocumentChange: () => persistence.flush(),
      documentChanged: (path) => {
        persistence.destroy();
        persistence = persistEditorState(view, path, state, saveState);
      },
      cursor: state.files[doc.path]?.cursor,
      dir: parentDirectory(doc.path),
      writeFile,
      quit: () => { void quit(); },
    });
    mark("editor created");
    const frame = new Promise<void>((resolve) => requestAnimationFrame(() => {
      performance.mark("mdw:first-paint");
      mark("first frame");
      resolve();
    }));
    persistence = persistEditorState(view, doc.path, state, saveState);
    let quitting = false;
    async function quit(): Promise<void> {
      if (quitting) return;
      quitting = true;
      try {
        await persistence.flush();
        await invoke("close_window");
      } catch (error) {
        quitting = false;
        view.dispatch({ effects: showMessage.of(`Cannot quit mdw: ${String(error)}`) });
      }
    }
    const closeListener = listenWindow("mdw-before-close", () => {
      if (isDirty(view.state)) {
        view.dispatch({ effects: showMessage.of("Unsaved changes. Use :w to save or :q! to discard.") });
        view.focus();
        return;
      }
      void quit();
    });
    if (config.warning) {
      console.warn(config.warning);
      view.dispatch({ effects: showMessage.of(config.warning) });
    }
    let stopping: number | undefined;
    const prepareStop = listenWindow<number>("mdw-prepare-stop", async ({ payload: id }) => {
      stopping = id;
      document.body.inert = true;
      let error: string | undefined;
      try {
        if (!isDirty(view.state)) await persistence.flush();
      } catch (cause) {
        error = String(cause);
      }
      await invoke("stop_result", { id, dirty: isDirty(view.state), error });
    });
    const cancelStop = listenWindow<number>("mdw-cancel-stop", ({ payload: id }) => {
      if (stopping === id) {
        stopping = undefined;
        document.body.inert = false;
        view.focus();
      }
    });
    await Promise.all([shown, closeListener, prepareStop, cancelStop, frame]);
    mark("finish_startup sent");
    await invoke("finish_startup", { ready: true, marks: timing ? timingMarks() : [] });
  } catch (error) {
    setTheme("auto");
    parent.textContent = `Cannot open document: ${String(error)}`;
    await invoke("finish_startup", { ready: false, error: String(error), marks: [] }).catch(console.error);
  }
}

void main();
