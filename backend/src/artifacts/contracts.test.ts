import { describe, expect, test } from "bun:test";
import type {
  ArtifactDescriptor as CanonicalArtifactDescriptor,
  ArtifactWorkpieceDescriptor as CanonicalArtifactWorkpieceDescriptor,
  ArtifactWorkpieceResult,
  ArtifactWorkpieceState,
  PresentationDeck,
  Workbook,
} from "@useagent/artifact-workspace";
import type {
  ArtifactDescriptor,
  ArtifactWorkpieceDescriptor,
} from "./repo";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type _ArtifactDescriptorIsCanonical = Assert<
  Equal<ArtifactDescriptor, CanonicalArtifactDescriptor>
>;
type _ArtifactWorkpieceDescriptorIsCanonical = Assert<
  Equal<ArtifactWorkpieceDescriptor, CanonicalArtifactWorkpieceDescriptor>
>;
type _PdfStateIsCorrelated = Assert<
  Equal<ArtifactWorkpieceState<"pdf">, Readonly<{ pdfText: string }>>
>;
type _PresentationResultStateIsCorrelated = Assert<
  Equal<
    Extract<ArtifactWorkpieceResult, { workpiece: { kind: "presentation" } }>["state"],
    Readonly<{ deck: PresentationDeck }> | null
  >
>;
type _SpreadsheetResultStateIsCorrelated = Assert<
  Equal<
    Extract<ArtifactWorkpieceResult, { workpiece: { kind: "spreadsheet" } }>["state"],
    Readonly<{ workbook: Workbook }> | null
  >
>;

describe("artifact repository contracts", () => {
  test("re-exports descriptors instead of declaring a backend copy", async () => {
    const source = await Bun.file(new URL("./repo.ts", import.meta.url)).text();
    expect(source).toMatch(
      /export type\s*\{\s*ArtifactDescriptor,\s*ArtifactWorkpieceDescriptor\s*\}\s*from "@useagent\/artifact-workspace";/,
    );
    expect(source).not.toMatch(/export interface Artifact(?:Workpiece)?Descriptor/);
  });

  test("derives backend defaults and transitional wire actions from shared contracts", async () => {
    const [authoring, repository] = await Promise.all([
      Bun.file(new URL("./authoring.ts", import.meta.url)).text(),
      Bun.file(new URL("./repo.ts", import.meta.url)).text(),
    ]);
    expect(authoring).toContain("artifactAuthoringProfile");
    expect(authoring).not.toMatch(/const DEFAULT_NAME/);
    expect(repository).toContain("ARTIFACT_LEGACY_WORKPIECE_ACTIONS");
    expect(repository).not.toMatch(/actions:\s*\["preview", "download", "edit"/);
  });
});
