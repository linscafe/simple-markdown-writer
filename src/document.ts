import { EditorState, StateEffect, StateField, type Text } from "@codemirror/state";

export const markSaved = StateEffect.define<Text>();
export const showMessage = StateEffect.define<string>();

export const savedDocument = StateField.define<Text>({
  create: (state) => state.doc,
  update: (saved, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(markSaved)) saved = effect.value;
    }
    return saved;
  },
});

export const statusMessage = StateField.define<string>({
  create: () => "",
  update: (message, transaction) => {
    if (transaction.docChanged) message = "";
    for (const effect of transaction.effects) {
      if (effect.is(showMessage)) message = effect.value;
    }
    return message;
  },
});

export function isDirty(state: EditorState): boolean {
  return !state.doc.eq(state.field(savedDocument));
}
