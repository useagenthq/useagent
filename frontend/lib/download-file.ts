/** Save text the app made (an export) as a file through the browser's download. */
export function downloadTextFile(content: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser a task to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
