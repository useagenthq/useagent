/** One decoder per terminal connection preserves UTF-8 code points split
 * across arbitrary PTY byte chunks. */
export function createTerminalChunkDecoder(): (data: Uint8Array) => string {
  const decoder = new TextDecoder("utf-8");
  return (data) => decoder.decode(data, { stream: true });
}
