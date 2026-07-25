/**
 * Escaping is the security boundary of a server-rendered site that publishes
 * user-submitted titles, comments and URLs. Adversarial by design.
 */
import { describe, it, expect } from "vitest";
import { escapeHtml, safeUrl, html, raw, toHtml, escapeJsonLd } from "../src/news/render/escape";

describe("escapeHtml", () => {
  it("neutralizes tag and attribute breakouts", () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml('" onerror="alert(1)')).toBe("&quot; onerror=&quot;alert(1)");
    expect(escapeHtml("' onload='x")).toBe("&#39; onload=&#39;x");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("handles null/undefined/numbers without producing 'null'", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(0)).toBe("0");
  });

  it("does not double-escape on a single pass", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;"); // one pass only — callers must not re-escape
  });
});

describe("safeUrl", () => {
  it("rejects script-bearing schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
    ]) {
      expect(safeUrl(bad)).toBeNull();
    }
  });

  it("allows ordinary web links", () => {
    expect(safeUrl("https://ex.com/a?b=1")).toBe("https://ex.com/a?b=1");
    expect(safeUrl("http://ex.com")).toBe("http://ex.com/");
  });

  it("allows site-relative paths but not protocol-relative ones", () => {
    expect(safeUrl("/item/123/slug")).toBe("/item/123/slug");
    expect(safeUrl("//evil.com/x")).toBeNull();
    expect(safeUrl("/ok?q=1&r=2")).toBe("/ok?q=1&r=2");
  });

  it("rejects empty and malformed input", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
  });
});

describe("html template", () => {
  it("escapes interpolations by default", () => {
    const title = '<img src=x onerror=alert(1)>';
    expect(toHtml(html`<h1>${title}</h1>`))
      .toBe("<h1>&lt;img src=x onerror=alert(1)&gt;</h1>");
  });

  it("escapes inside attributes too", () => {
    const v = '" autofocus onfocus="alert(1)';
    expect(toHtml(html`<a title="${v}">x</a>`)).not.toContain('onfocus="alert');
  });

  it("only emits unescaped content through the explicit raw() opt-out", () => {
    expect(toHtml(html`<div>${raw("<b>bold</b>")}</div>`)).toBe("<div><b>bold</b></div>");
  });

  it("renders arrays and skips null/undefined/false", () => {
    expect(toHtml(html`${[1, 2, 3]}`)).toBe("123");
    expect(toHtml(html`a${null}b${undefined}c${false}d`)).toBe("abcd");
  });

  it("nests without double-escaping", () => {
    const inner = html`<span>${"a & b"}</span>`;
    expect(toHtml(html`<p>${inner}</p>`)).toBe("<p><span>a &amp; b</span></p>");
  });
});

describe("escapeJsonLd", () => {
  it("prevents breaking out of the script block", () => {
    const out = escapeJsonLd({ headline: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
    expect(JSON.parse(out.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")).headline)
      .toBe("</script><script>alert(1)</script>");
  });
});
