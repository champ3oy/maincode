import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import type { LanguageKey } from "./language";

export function cmLanguageFor(key: LanguageKey | null): Extension[] {
  switch (key) {
    case "javascript":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "python":
      return [python()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "rust":
      return [rust()];
    case "yaml":
      return [yaml()];
    default:
      return [];
  }
}
