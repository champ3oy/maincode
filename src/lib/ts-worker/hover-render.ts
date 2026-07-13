// Builds the DOM for the TS hover tooltip, Zed-style:
//   - a syntax-highlighted signature block (each SymbolDisplayPart colored by kind)
//   - a divider
//   - the full JSDoc rendered as markdown
//   - JSDoc tags (@example as a code block, @param as "name — text", etc.)
//
// Kept separate from cm.ts so the CodeMirror extension stays thin. Styling lives
// in cm-theme.ts (tooltipTheme); this module only sets structural classes and
// the per-kind signature colors.

import { hoverKindColor } from "../cm-theme";
import { renderMarkdown } from "./markdown-dom";
import type { HoverResult } from "./protocol";

/** Build the tooltip root element for a hover result. */
export function renderHover(info: HoverResult): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-ts-hover";

  dom.appendChild(renderSignature(info.signature));

  const hasDocs = info.documentation.trim().length > 0;
  const hasTags = info.tags.length > 0;
  if (hasDocs || hasTags) {
    const hr = document.createElement("hr");
    hr.className = "cm-ts-hover-divider";
    dom.appendChild(hr);
  }

  if (hasDocs) {
    const docs = document.createElement("div");
    docs.className = "cm-ts-hover-docs";
    docs.appendChild(renderMarkdown(info.documentation));
    dom.appendChild(docs);
  }

  for (const tag of info.tags) {
    dom.appendChild(renderTag(tag));
  }

  return dom;
}

/** Signature: one <span> per display part, colored by its TS kind. */
function renderSignature(parts: HoverResult["signature"]): HTMLElement {
  const sig = document.createElement("div");
  sig.className = "cm-ts-hover-sig";
  for (const part of parts) {
    const span = document.createElement("span");
    span.appendChild(document.createTextNode(part.text));
    const color = hoverKindColor(part.kind);
    if (color) span.style.color = color;
    sig.appendChild(span);
  }
  return sig;
}

/** A single JSDoc tag block. */
function renderTag(tag: { name: string; text: string }): HTMLElement {
  const block = document.createElement("div");
  block.className = "cm-ts-hover-tag";

  const name = document.createElement("span");
  name.className = "cm-ts-hover-tag-name";
  name.appendChild(document.createTextNode("@" + tag.name));
  block.appendChild(name);

  const text = tag.text ?? "";

  if (tag.name === "example") {
    // Render example bodies as a fenced code block (monospace, no highlight).
    if (text.trim()) {
      const pre = document.createElement("pre");
      pre.className = "cm-ts-hover-code";
      const code = document.createElement("code");
      code.appendChild(document.createTextNode(stripExampleFences(text)));
      pre.appendChild(code);
      block.appendChild(pre);
    }
  } else if (isParamLike(tag.name)) {
    // "@param name — description". TS packs "name description" into text; the
    // name is the leading token, the rest is the (markdown) description.
    const trimmed = text.trim();
    const sp = trimmed.search(/\s/);
    const paramName = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
    if (paramName) {
      block.appendChild(document.createTextNode(" "));
      const nameCode = document.createElement("code");
      nameCode.appendChild(document.createTextNode(paramName));
      block.appendChild(nameCode);
    }
    if (rest) {
      block.appendChild(document.createTextNode(" — "));
      const span = document.createElement("span");
      span.appendChild(renderMarkdown(rest));
      block.appendChild(span);
    }
  } else if (text.trim()) {
    block.appendChild(document.createTextNode(" "));
    const span = document.createElement("span");
    span.appendChild(renderMarkdown(text.trim()));
    block.appendChild(span);
  }

  return block;
}

function isParamLike(name: string): boolean {
  return name === "param" || name === "arg" || name === "argument" || name === "property";
}

/** Some TS versions wrap @example text in ``` fences; unwrap so we don't double-fence. */
function stripExampleFences(text: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}
