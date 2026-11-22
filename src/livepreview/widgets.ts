import { type EditorState, Transaction } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";

export function toggleTask(state: EditorState, from: number): Transaction | null {
  const marker = state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return null;
  return state.update({
    changes: { from: from + 1, to: from + 2, insert: marker[1] === " " ? "x" : " " },
    annotations: Transaction.userEvent.of("input"),
  });
}

export class BulletWidget extends WidgetType {
  eq(other: WidgetType): boolean { return other instanceof BulletWidget; }

  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-md-bullet";
    bullet.textContent = "•";
    bullet.setAttribute("aria-hidden", "true");
    return bullet;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }

  eq(other: WidgetType): boolean {
    return other instanceof CheckboxWidget && other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "cm-md-checkbox";
    checkbox.checked = this.checked;
    checkbox.tabIndex = -1;
    checkbox.setAttribute("aria-label", "Toggle task");
    checkbox.addEventListener("mousedown", (event) => event.preventDefault());
    checkbox.addEventListener("click", () => {
      const transaction = toggleTask(view.state, view.posAtDOM(checkbox));
      if (transaction) view.dispatch(transaction);
    });
    return checkbox;
  }
}

export class HorizontalRuleWidget extends WidgetType {
  eq(other: WidgetType): boolean { return other instanceof HorizontalRuleWidget; }

  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-hr";
    rule.setAttribute("role", "separator");
    return rule;
  }
}
