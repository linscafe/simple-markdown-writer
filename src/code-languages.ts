import { defineLanguageFacet, Language, LanguageDescription, ParseContext } from "@codemirror/language";

let catalog: readonly LanguageDescription[] | undefined;
let loading: Language | undefined;

export function codeLanguage(info: string): LanguageDescription | Language | null {
  if (catalog) return LanguageDescription.matchLanguageName(catalog, info, true);
  if (!loading) {
    const ready = import("@codemirror/language-data").then(async ({ languages }) => {
      catalog = languages;
      await LanguageDescription.matchLanguageName(languages, info, true)?.load();
    }).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    // CodeMirror reparses the skipped fence once the catalog and its first grammar are ready.
    loading = new Language(defineLanguageFacet(), ParseContext.getSkippingParser(ready));
  }
  return loading;
}
