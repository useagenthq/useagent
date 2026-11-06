import { describe, expect, test } from "bun:test";
import {
  attachmentIntake,
  attachmentKind,
  MAX_UPLOAD_BYTES,
  preflightFailure,
  releasePreview,
  type RunUpload,
  uploadFailureReason,
  uploadNotice,
  withoutSent,
} from "./run-uploads";

describe("attachment kinds", () => {
  test("by extension, case-insensitive, before the browser's MIME guess", () => {
    expect(attachmentKind("Report.XLSX")).toBe("spreadsheet");
    expect(attachmentKind("deck.key")).toBe("presentation");
    expect(attachmentKind("notes.md", "text/markdown")).toBe("document");
    expect(attachmentKind("gateway.ts", "video/mp2t")).toBe("code");
    expect(attachmentKind("shot.PNG")).toBe("image");
    expect(attachmentKind("clip.mov")).toBe("video");
  });

  test("by MIME type when the extension says nothing", () => {
    expect(attachmentKind("photo", "image/heic")).toBe("image");
    expect(attachmentKind("export", "text/csv")).toBe("spreadsheet");
    expect(attachmentKind("slides", "application/vnd.ms-powerpoint")).toBe("presentation");
    expect(attachmentKind("paper", "application/pdf")).toBe("document");
  });

  test("anything else is a plain file", () => {
    expect(attachmentKind("trace.zip", "application/zip")).toBe("file");
    expect(attachmentKind("Makefile")).toBe("file");
    expect(attachmentKind("blob", "application/octet-stream")).toBe("file");
  });
});

describe("attachment intake", () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => new File(["x"], `f${i}.png`)) as unknown as FileList;
  const drag = (types: string[], count: number) => {
    let prevented = false;
    const dataTransfer = { types, files: files(count), dropEffect: "" } as unknown as DataTransfer;
    return {
      event: {
        preventDefault: () => {
          prevented = true;
        },
        dataTransfer,
      },
      dataTransfer,
      prevented: () => prevented,
    };
  };

  test("a drop with files becomes uploads; a drag without files passes through", () => {
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f));
    const withFiles = drag(["Files"], 2);
    intake.onDragOver(withFiles.event);
    expect(withFiles.prevented()).toBe(true);
    expect(withFiles.dataTransfer.dropEffect).toBe("copy");
    intake.onDrop(withFiles.event);
    expect(added).toHaveLength(1);
    const text = drag(["text/plain"], 0);
    intake.onDragOver(text.event);
    intake.onDrop(text.event);
    expect(text.prevented()).toBe(false);
    expect(added).toHaveLength(1);
  });

  test("a pasted file becomes an upload; a text paste is left to the field", () => {
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f));
    let prevented = false;
    const paste = (count: number) => ({
      preventDefault: () => {
        prevented = true;
      },
      clipboardData: { files: files(count) } as unknown as DataTransfer,
    });
    intake.onPaste(paste(0));
    expect(prevented).toBe(false);
    expect(added).toHaveLength(0);
    intake.onPaste(paste(1));
    expect(prevented).toBe(true);
    expect(added).toHaveLength(1);
  });

  test("while a send is in flight a drop or paste is claimed but adds nothing", () => {
    // The request already carries the attachment ids; a file arriving now would
    // show as a tile and never be sent. The browser's default for an unclaimed
    // drop is to open the file, so the events are still consumed.
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f), false);
    const drop = drag(["Files"], 1);
    intake.onDragOver(drop.event);
    expect(drop.dataTransfer.dropEffect).toBe("none");
    intake.onDrop(drop.event);
    expect(drop.prevented()).toBe(true);
    let pastePrevented = false;
    intake.onPaste({
      preventDefault: () => {
        pastePrevented = true;
      },
      clipboardData: { files: files(1) } as unknown as DataTransfer,
    });
    expect(pastePrevented).toBe(true);
    expect(added).toHaveLength(0);
  });
});

describe("after a send", () => {
  const upload = (localId: string, id: string | null): RunUpload => ({
    localId,
    id,
    name: `${localId}.pdf`,
    sizeBytes: 1,
    status: id ? "ready" : "uploading",
    kind: "document",
    previewUrl: null,
    progress: id ? 100 : 10,
  });

  test("only the uploads the send carried leave; a later arrival stays for the next message", () => {
    const sentEarlier = upload("a", "up-a");
    const sentToo = upload("b", "up-b");
    const arrivedDuringSend = upload("c", "up-c");
    const stillUploading = upload("d", null);
    const kept = withoutSent([sentEarlier, sentToo, arrivedDuringSend, stillUploading], ["up-a", "up-b"]);
    expect(kept.map((item) => item.localId)).toEqual(["c", "d"]);
  });
});

describe("thumbnail release", () => {
  test("revokes the preview object URL and skips tiles without one", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      releasePreview({ previewUrl: "blob:local/one" });
      releasePreview({ previewUrl: null });
    } finally {
      URL.revokeObjectURL = original;
    }
    expect(revoked).toEqual(["blob:local/one"]);
  });
});

describe("why an upload failed", () => {
  test("the backend's refusals become words that follow the file name", () => {
    expect(uploadFailureReason(413, "file exceeds 25 MB limit")).toBe("is over the 25 MB limit");
    expect(uploadFailureReason(400, "file is empty")).toBe("is empty");
    expect(uploadFailureReason(400, "invalid file name")).toBe(
      "has a name that cannot be uploaded",
    );
    expect(uploadFailureReason(422, "upload_scan_failed")).toBe("did not pass the upload scan");
    expect(uploadFailureReason(401, "authenticated user required")).toBe(
      "did not upload because you are signed out",
    );
  });

  test("a status without a known message still says what it can", () => {
    // A proxy in front of the backend answers 413 with its own page.
    expect(uploadFailureReason(413)).toBe("is over the 25 MB limit");
    expect(uploadFailureReason(422)).toBe("did not pass the upload scan");
    expect(uploadFailureReason(500, "internal error")).toBe("did not upload");
    expect(uploadFailureReason(null)).toBe(
      "did not upload because the server could not be reached",
    );
  });

  test("a file over 25 MB or an empty one fails before it is sent", () => {
    expect(preflightFailure({ size: 30 * 1024 * 1024 })).toBe("is over the 25 MB limit");
    expect(preflightFailure({ size: 0 })).toBe("is empty");
    expect(preflightFailure({ size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(preflightFailure({ size: MAX_UPLOAD_BYTES + 1 })).toBe("is over the 25 MB limit");
    expect(preflightFailure({ size: 1 })).toBeNull();
  });
});

describe("the composer's upload notice", () => {
  const ready = { name: "a.png", status: "ready" as const };
  test("nothing to say when every file landed and none was left out", () => {
    expect(uploadNotice([ready], 0)).toBeNull();
    expect(uploadNotice([{ name: "b.png", status: "uploading" }], 0)).toBeNull();
  });

  test("files past the 10-file cap are counted", () => {
    expect(uploadNotice([ready], 2)).toEqual({
      tone: "info",
      text: "2 files were left out. A message can carry up to 10 files.",
    });
    expect(uploadNotice([], 1)?.text).toBe(
      "1 file was left out. A message can carry up to 10 files.",
    );
  });

  test("a failed file says why, and that removing it frees Send", () => {
    const failed = {
      name: "report.pdf",
      status: "error" as const,
      error: "is over the 25 MB limit",
    };
    expect(uploadNotice([ready, failed], 0)).toEqual({
      tone: "error",
      text: "Remove report.pdf to send. It is over the 25 MB limit.",
    });
    // It blocks Send, so it outranks the left-out count.
    expect(uploadNotice([failed], 3)?.tone).toBe("error");
    // A record from before reasons were kept still reads as a sentence.
    expect(uploadNotice([{ name: "x.zip", status: "error" }], 0)?.text).toBe(
      "Remove x.zip to send. It did not upload.",
    );
  });

  test("several failed files are counted, with the first one's reason", () => {
    const notice = uploadNotice(
      [
        { name: "big.mov", status: "error", error: "is over the 25 MB limit" },
        { name: "empty.txt", status: "error", error: "is empty" },
      ],
      0,
    );
    expect(notice?.text).toBe(
      "Remove the 2 failed files to send. big.mov is over the 25 MB limit.",
    );
  });
});
