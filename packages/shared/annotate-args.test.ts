import { describe, test, expect } from "bun:test";
import { parseAnnotateArgs } from "./annotate-args";

describe("parseAnnotateArgs", () => {
  test("path only", () => {
    expect(parseAnnotateArgs("spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  test("path with --gate at end", () => {
    expect(parseAnnotateArgs("spec.md --gate")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("--gate before path", () => {
    expect(parseAnnotateArgs("--gate spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("path with both flags", () => {
    expect(parseAnnotateArgs("spec.md --gate --json")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: true,
      silentApprove: false,
    });
  });

  test("flags only, no path", () => {
    expect(parseAnnotateArgs("--gate --json")).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: true,
      json: true,
      silentApprove: false,
    });
  });

  test("path with spaces rejoins with single space", () => {
    expect(parseAnnotateArgs("my file.md --gate")).toEqual({
      filePath: "my file.md",
      rawFilePath: "my file.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  // `@` is the reference-mode marker (Claude Code / OpenCode / Pi convention),
  // not part of the filename. The parser strips it on `filePath` as the primary
  // behavior — that's the common case. `rawFilePath` preserves the original
  // for callers that want to try the literal form as a fallback (scoped-package-
  // style names). See at-reference.ts for the combined helper.

  test("leading @ is stripped (reference-mode primary) and rawFilePath preserves it", () => {
    expect(parseAnnotateArgs("@spec.md --gate")).toEqual({
      filePath: "spec.md",
      rawFilePath: "@spec.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("scoped-package-style path: filePath stripped, rawFilePath literal", () => {
    expect(parseAnnotateArgs("@plannotator/ui/README.md")).toEqual({
      filePath: "plannotator/ui/README.md",
      rawFilePath: "@plannotator/ui/README.md",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  test("@ stripped on filePath when combined with --gate --json, raw preserved", () => {
    expect(parseAnnotateArgs("@docs/spec.md --gate --json")).toEqual({
      filePath: "docs/spec.md",
      rawFilePath: "@docs/spec.md",
      gate: true,
      json: true,
      silentApprove: false,
    });
  });

  test("URL passes through", () => {
    expect(parseAnnotateArgs("https://example.com/docs --gate")).toEqual({
      filePath: "https://example.com/docs",
      rawFilePath: "https://example.com/docs",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("extra whitespace is collapsed", () => {
    expect(parseAnnotateArgs("  spec.md   --gate  ")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("empty string produces empty result", () => {
    expect(parseAnnotateArgs("")).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  test("nullish input is tolerated", () => {
    expect(parseAnnotateArgs(undefined as unknown as string)).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  test("folder path with trailing slash", () => {
    expect(parseAnnotateArgs("./specs/ --gate --json")).toEqual({
      filePath: "./specs/",
      rawFilePath: "./specs/",
      gate: true,
      json: true,
      silentApprove: false,
    });
  });

  // Regressions from the initial parser: the tokenize-and-rejoin approach
  // collapsed consecutive whitespace in file paths. Before this branch,
  // OpenCode and Pi passed the raw args string straight through, so files
  // with double-spaces or tabs in their names worked fine. These tests pin
  // that behavior so we don't regress it again.

  test("double-space inside a file path is preserved (flag at end)", () => {
    expect(parseAnnotateArgs("My  Notes.md --gate")).toEqual({
      filePath: "My  Notes.md",
      rawFilePath: "My  Notes.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("double-space inside a file path is preserved (flag at start)", () => {
    expect(parseAnnotateArgs("--gate My  Notes.md")).toEqual({
      filePath: "My  Notes.md",
      rawFilePath: "My  Notes.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("tab inside a file path is preserved", () => {
    expect(parseAnnotateArgs("My\tNotes.md --gate")).toEqual({
      filePath: "My\tNotes.md",
      rawFilePath: "My\tNotes.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("multi-whitespace path with no flags passes through untouched", () => {
    expect(parseAnnotateArgs("/tmp/My  Notes.md")).toEqual({
      filePath: "/tmp/My  Notes.md",
      rawFilePath: "/tmp/My  Notes.md",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  // OpenCode and Pi don't go through a shell, so users who quote paths
  // (shell muscle memory, copy-paste from docs) have literal quote
  // characters reach the parser. Strip them at the tokenization layer
  // so downstream callers don't have to reason about quoting.

  test("wrapping double quotes are stripped from both filePath and rawFilePath", () => {
    expect(parseAnnotateArgs(`"@foo.md" --gate`)).toEqual({
      filePath: "foo.md",
      rawFilePath: "@foo.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("wrapping single quotes are stripped", () => {
    expect(parseAnnotateArgs(`'@foo.md' --gate`)).toEqual({
      filePath: "foo.md",
      rawFilePath: "@foo.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("wrapping quotes around a path with spaces", () => {
    expect(parseAnnotateArgs(`"@My Notes.md" --gate`)).toEqual({
      filePath: "My Notes.md",
      rawFilePath: "@My Notes.md",
      gate: true,
      json: false,
      silentApprove: false,
    });
  });

  test("wrapping quotes without @ still get stripped", () => {
    expect(parseAnnotateArgs(`"My Notes.md"`)).toEqual({
      filePath: "My Notes.md",
      rawFilePath: "My Notes.md",
      gate: false,
      json: false,
      silentApprove: false,
    });
  });

  // --silent-approve (issue #570 follow-up) opts the plaintext Approve out of
  // emitting the "The user approved." marker. It parses identically to the
  // other flags and is recognized in any position, including without --gate
  // (where it's a documented no-op — the parser still strips it so it doesn't
  // leak into the path).

  test("--silent-approve alongside --gate", () => {
    expect(parseAnnotateArgs("spec.md --gate --silent-approve")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      silentApprove: true,
    });
  });

  test("--silent-approve with all three flags", () => {
    expect(parseAnnotateArgs("spec.md --gate --json --silent-approve")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: true,
      silentApprove: true,
    });
  });

  test("--silent-approve alone is stripped from path (no-op but not leaked)", () => {
    expect(parseAnnotateArgs("spec.md --silent-approve")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: false,
      json: false,
      silentApprove: true,
    });
  });

  test("--silent-approve before path", () => {
    expect(parseAnnotateArgs("--silent-approve --gate spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      silentApprove: true,
    });
  });
});
