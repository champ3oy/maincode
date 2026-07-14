import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { c, cpp, csharp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
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
    // Legacy stream modes (@codemirror/legacy-modes) for the long tail.
    case "toml":
      return [StreamLanguage.define(toml)];
    case "ini":
      return [StreamLanguage.define(properties)];
    case "shell":
      return [StreamLanguage.define(shell)];
    case "dockerfile":
      return [StreamLanguage.define(dockerFile)];
    case "xml":
      return [StreamLanguage.define(xml)];
    case "sql":
      return [StreamLanguage.define(standardSQL)];
    case "c":
      return [StreamLanguage.define(c)];
    case "cpp":
      return [StreamLanguage.define(cpp)];
    case "java":
      return [StreamLanguage.define(java)];
    case "kotlin":
      return [StreamLanguage.define(kotlin)];
    case "csharp":
      return [StreamLanguage.define(csharp)];
    case "go":
      return [StreamLanguage.define(go)];
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "diff":
      return [StreamLanguage.define(diff)];
    default:
      return [];
  }
}
