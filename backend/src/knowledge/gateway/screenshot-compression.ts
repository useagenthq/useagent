import sharp from "sharp";

export const MODEL_SCREENSHOT_MAX_BYTES = 512 * 1024;

const PROFILES = [
  { width: 1280, quality: 68 },
  { width: 960, quality: 56 },
  { width: 720, quality: 44 },
  { width: 512, quality: 35 },
] as const;

/** Keep the full PNG in the sandbox, but bound the copy carried in model history. */
export async function compressScreenshotForModel(source: Buffer): Promise<Buffer> {
  if (source.byteLength === 0) throw new Error("desktop screenshot was empty");
  for (const profile of PROFILES) {
    const compressed = await sharp(source, { limitInputPixels: 50_000_000 })
      .resize({
        width: profile.width,
        height: profile.width,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: profile.quality, progressive: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
    if (compressed.byteLength <= MODEL_SCREENSHOT_MAX_BYTES) return compressed;
  }
  throw new Error("desktop screenshot could not be compressed below the model payload limit");
}
