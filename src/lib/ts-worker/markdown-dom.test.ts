// @vitest-environment jsdom
//
// Verifies the dependency-free markdown → DOM renderer used by the TS hover
// tooltip. The critical property is SAFETY: because docs come from untrusted
// node_modules, the renderer must NEVER produce an element from raw markup via
// innerHTML — every node is asserted structurally, and we confirm raw HTML in
// the source is treated as literal text (not parsed into elements).

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-dom";

/** Collect all descendant elements of a fragment as an array. */
function els(frag: DocumentFragment): Element[] {
  return Array.from(frag.querySelectorAll("*"));
}

describe("renderMarkdown", () => {
  it("renders a fenced code block as pre > code with the code text", () => {
    const frag = renderMarkdown("```ts\nconst x = 1;\n```");
    const pre = frag.querySelector("pre.cm-ts-hover-code");
    expect(pre).not.toBeNull();
    const code = pre!.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("const x = 1;");
  });

  it("renders inline `code` as a <code> element", () => {
    const frag = renderMarkdown("use `foo()` here");
    const code = frag.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("foo()");
    // sits inside a paragraph
    expect(frag.querySelector("p")).not.toBeNull();
  });

  it("renders [a](http://x) as an <a> with text 'a' and title 'http://x'", () => {
    const frag = renderMarkdown("see [a](http://x)");
    const a = frag.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("a");
    expect(a!.getAttribute("title")).toBe("http://x");
    // no navigable href — styled affordance only
    expect(a!.getAttribute("href")).toBeNull();
  });

  it("renders {@link Foo} as a <code> with 'Foo'", () => {
    const frag = renderMarkdown("references {@link Foo}");
    const code = frag.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("Foo");
  });

  it("renders {@linkcode Bar} as a <code> with 'Bar'", () => {
    const frag = renderMarkdown("{@linkcode Bar}");
    const code = frag.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("Bar");
  });

  it("renders plain text as a text node (no elements beyond the paragraph)", () => {
    const frag = renderMarkdown("just words");
    const p = frag.querySelector("p");
    expect(p).not.toBeNull();
    // the paragraph's only child is a Text node
    expect(p!.childNodes).toHaveLength(1);
    expect(p!.firstChild!.nodeType).toBe(3 /* Node.TEXT_NODE */);
    expect(p!.textContent).toBe("just words");
    // no inline elements were produced
    expect(els(frag).map((e) => e.tagName)).toEqual(["P"]);
  });

  it("renders **bold** and *italic* as <strong> / <em>", () => {
    const frag = renderMarkdown("**b** and *i*");
    expect(frag.querySelector("strong")!.textContent).toBe("b");
    expect(frag.querySelector("em")!.textContent).toBe("i");
  });

  it("splits blank-line-separated paragraphs", () => {
    const frag = renderMarkdown("one\n\ntwo");
    const ps = frag.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0].textContent).toBe("one");
    expect(ps[1].textContent).toBe("two");
  });

  it("NEVER parses raw HTML into elements — it stays literal text", () => {
    // If innerHTML were used anywhere, this would produce an <img>/<script>.
    const evil = 'a <img src=x onerror=alert(1)> <script>alert(2)</script> b';
    const frag = renderMarkdown(evil);
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.querySelector("script")).toBeNull();
    // The angle-bracket markup survives verbatim as text content.
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(frag.textContent).toContain("<script>alert(2)</script>");
    // The only element is the wrapping paragraph.
    expect(els(frag).map((e) => e.tagName)).toEqual(["P"]);
  });

  it("leaves an unclosed inline marker as literal text", () => {
    const frag = renderMarkdown("a `unclosed code");
    expect(frag.querySelector("code")).toBeNull();
    expect(frag.textContent).toBe("a `unclosed code");
  });
});
