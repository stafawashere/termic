import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { rust } from "@codemirror/lang-rust";
import { html } from "@codemirror/lang-html";
import {
  MAX_REINDENT_CHARS,
  applyEdits,
  detectSourceIndent,
  planReindent,
  reindentToThree,
} from "./reindent";

const twoSpace = [
  "function main() {",
  "  if (ready) {",
  "    run();",
  "    stop();",
  "  }",
  "  return 1;",
  "}",
  "",
].join("\n");

const fourSpace = [
  "function main() {",
  "    if (ready) {",
  "        run();",
  "        stop();",
  "    }",
  "    return 1;",
  "}",
  "",
].join("\n");

const tabbed = [
  "function main() {",
  "\tif (ready) {",
  "\t\trun();",
  "\t\tstop();",
  "\t}",
  "\treturn 1;",
  "}",
  "",
].join("\n");

const threeSpace = [
  "function main() {",
  "   if (ready) {",
  "      run();",
  "      stop();",
  "   }",
  "   return 1;",
  "}",
  "",
].join("\n");

function stateFor(doc: string, language: Extension = javascript()): EditorState {
  return EditorState.create({ doc, extensions: [language] });
}

function planned(doc: string, languageId: string, language: Extension = javascript()): string | null {
  const state = stateFor(doc, language);
  const plan = planReindent(state, languageId);
  return plan ? applyEdits(doc, plan.edits) : null;
}

describe("detectSourceIndent", () => {
  it("reads 2, 4 and 8 space files", () => {
    const eightSpace = fourSpace.replace(/ {4}/g, "        ");

    expect(detectSourceIndent(twoSpace)).toEqual({ kind: "spaces", size: 2 });
    expect(detectSourceIndent(fourSpace)).toEqual({ kind: "spaces", size: 4 });
    expect(detectSourceIndent(eightSpace)).toEqual({ kind: "spaces", size: 8 });
  });

  it("reads a tab indented file", () => {
    expect(detectSourceIndent(tabbed)).toEqual({ kind: "tabs" });
  });

  it("recognises a file that is already at 3", () => {
    expect(detectSourceIndent(threeSpace)).toEqual({ kind: "spaces", size: 3 });
  });

  it("refuses a file that mixes tabs and spaces", () => {
    const mixed = "a {\n\tb;\n    c;\n    d;\n}\n";

    expect(detectSourceIndent(mixed)).toBeNull();
  });

  it("refuses a file with no indentation or no clear width", () => {
    expect(detectSourceIndent("one\ntwo\nthree\n")).toBeNull();
    expect(detectSourceIndent("a\n  b\n")).toBeNull();
    expect(detectSourceIndent("a\n  b\nc\n    d\ne\n  f\nz\n    g\n")).toBeNull();
  });

  it("does not let a doc comment gutter outvote the code", () => {
    const doc = [
      "class A {",
      "    /**",
      "     * text",
      "     */",
      "    run() {",
      "        go();",
      "    }",
      "}",
      "",
    ].join("\n");

    expect(detectSourceIndent(doc)).toEqual({ kind: "spaces", size: 4 });
  });
});

describe("reindentToThree", () => {
  it("moves 2 and 4 space levels to 3", () => {
    expect(reindentToThree(twoSpace, { kind: "spaces", size: 2 })).toBe(threeSpace);
    expect(reindentToThree(fourSpace, { kind: "spaces", size: 4 })).toBe(threeSpace);
  });

  it("moves tabs to 3 spaces per level", () => {
    expect(reindentToThree(tabbed, { kind: "tabs" })).toBe(threeSpace);
  });

  it("keeps alignment spaces that follow the indent levels", () => {
    const aligned = "call(\n    first,\n     second,\n)\n";
    const expected = "call(\n   first,\n    second,\n)\n";

    expect(reindentToThree(aligned, { kind: "spaces", size: 4 })).toBe(expected);
  });

  it("leaves a file already at 3 untouched", () => {
    expect(reindentToThree(threeSpace, { kind: "spaces", size: 3 })).toBe(threeSpace);
  });

  it("preserves CRLF endings", () => {
    const crlf = twoSpace.replace(/\n/g, "\r\n");
    const expected = threeSpace.replace(/\n/g, "\r\n");

    expect(reindentToThree(crlf, { kind: "spaces", size: 2 })).toBe(expected);
  });

  it("preserves a missing trailing newline", () => {
    const noNewline = twoSpace.slice(0, -1);
    const result = reindentToThree(noNewline, { kind: "spaces", size: 2 });

    expect(result.endsWith("}")).toBe(true);
    expect(result).toBe(threeSpace.slice(0, -1));
  });

  it("does not touch blank or whitespace-only lines", () => {
    const doc = "a {\n  b;\n\n    \n  c;\n}\n";
    const result = reindentToThree(doc, { kind: "spaces", size: 2 });

    expect(result).toBe("a {\n   b;\n\n    \n   c;\n}\n");
  });

  it("is idempotent", () => {
    const once = reindentToThree(twoSpace, { kind: "spaces", size: 2 });

    expect(detectSourceIndent(once)).toEqual({ kind: "spaces", size: 3 });
    expect(reindentToThree(once, { kind: "spaces", size: 3 })).toBe(once);
  });
});

describe("planReindent", () => {
  it("reindents a plain source file", () => {
    expect(planned(twoSpace, "TypeScript")).toBe(threeSpace);
  });

  it("leaves a multi-line template literal and a block comment alone", () => {
    const doc = [
      "function f() {",
      "  const sql = `",
      "    select 1",
      "      from t",
      "  `;",
      "  /*",
      "     kept",
      "  */",
      "  if (a) {",
      "    g();",
      "  }",
      "}",
      "",
    ].join("\n");
    const expected = [
      "function f() {",
      "   const sql = `",
      "    select 1",
      "      from t",
      "  `;",
      "   /*",
      "     kept",
      "  */",
      "   if (a) {",
      "      g();",
      "   }",
      "}",
      "",
    ].join("\n");

    expect(planned(doc, "JavaScript")).toBe(expected);
  });

  it("leaves a multi-line CSS comment alone", () => {
    const doc = "a {\n  /* one\n       two */\n  color: red;\n  b {\n    top: 0;\n  }\n}\n";
    const result = planned(doc, "CSS", css());

    expect(result).toContain("\n       two */");
    expect(result).toContain("\n   color: red;");
    expect(result).toContain("\n      top: 0;");
  });

  it("leaves a Rust raw string alone", () => {
    const doc = "fn main() {\n    let a = r#\"x\n        y\"#;\n    if a {\n        b();\n    }\n}\n";
    const result = planned(doc, "Rust", rust());

    expect(result).toContain("        y\"#;");
    expect(result).toContain("\n   let a = r#\"x");
    expect(result).toContain("\n      b();");
  });

  it("leaves a pre element alone", () => {
    const doc = "<div>\n  <pre>\n    keep\n  </pre>\n  <p>\n    text\n  </p>\n</div>\n";
    const result = planned(doc, "HTML", html());

    expect(result).toContain("\n    keep\n");
    expect(result).toContain("\n   <p>\n      text\n   </p>");
  });

  it("leaves a Kotlin raw string and block comment alone", () => {
    const doc = [
      "fun main() {",
      "    val a = \"\"\"",
      "        raw",
      "    \"\"\"",
      "    /*",
      "        note",
      "    */",
      "    if (a) {",
      "        go()",
      "    }",
      "}",
      "",
    ].join("\n");
    const result = planned(doc, "Kotlin", []);

    expect(result).toContain("\n        raw\n    \"\"\"\n");
    expect(result).toContain("\n        note\n    */\n");
    expect(result).toContain("\n      go()\n");
  });

  it("leaves a Swift multi-line string alone", () => {
    const doc = "func f() {\n    let a = \"\"\"\n        text\n        \"\"\"\n    if a {\n        g()\n    }\n}\n";
    const result = planned(doc, "Swift", []);

    expect(result).toContain("\n        text\n        \"\"\"\n");
    expect(result).toContain("\n      g()\n");
  });

  it("leaves a Lua long string alone", () => {
    const doc = "function f()\n    local a = [[\n        text\n    ]]\n    if a then\n        g()\n    end\nend\n";
    const result = planned(doc, "Lua", []);

    expect(result).toContain("\n        text\n    ]]\n");
    expect(result).toContain("\n      g()\n");
  });

  it("skips languages outside the allow list", () => {
    expect(planned(twoSpace, "Python")).toBeNull();
    expect(planned(twoSpace, "YAML")).toBeNull();
    expect(planned(twoSpace, "Makefile")).toBeNull();
    expect(planned(twoSpace, "Go")).toBeNull();
    expect(planned(twoSpace, "Markdown")).toBeNull();
    expect(planned(twoSpace, "Plain Text")).toBeNull();
  });

  it("skips mixed, already-3 and oversized files", () => {
    const mixed = "a {\n\tb;\n    c;\n    d;\n}\n";
    const huge = twoSpace.repeat(Math.ceil(MAX_REINDENT_CHARS / twoSpace.length) + 1);

    expect(planned(mixed, "JavaScript")).toBeNull();
    expect(planned(threeSpace, "JavaScript")).toBeNull();
    expect(planned(huge, "JavaScript")).toBeNull();
  });

  it("converts a tab indented file", () => {
    expect(planned(tabbed, "JavaScript")).toBe(threeSpace);
  });
});
