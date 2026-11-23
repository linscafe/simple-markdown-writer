import { defineLanguageFacet, Language, LanguageDescription, ParseContext } from "@codemirror/language";

let catalog: readonly LanguageDescription[] | undefined;
let loading: Language | undefined;

async function languageCatalog(): Promise<readonly LanguageDescription[]> {
  return catalog ??= (await import("@codemirror/language-data")).languages;
}

export async function loadFileLanguage(filename: string) {
  return LanguageDescription.matchFilename(await languageCatalog(), filename)?.load();
}

export function codeLanguage(info: string): LanguageDescription | Language | null {
  if (catalog) return LanguageDescription.matchLanguageName(catalog, info, true);
  if (!loading) {
    const ready = languageCatalog().then(async (languages) => {
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
