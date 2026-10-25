import { RESOURCE_LIMITS } from "./contracts";

function dimensions(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) return [view.getUint32(16), view.getUint32(20)];
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const type = String.fromCharCode(...bytes.slice(12, 16));
    if (type === "VP8X") return [1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536, 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536];
    if (type === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    if (type === "VP8L" && bytes[20] === 0x2f) return [1 + ((bytes[22] & 0x3f) << 8 | bytes[21]), 1 + ((bytes[24] & 0xf) << 10 | bytes[23] << 2 | bytes[22] >> 6)];
  }
  return null;
}

/** Inspect image headers before decoding, and retain only a small resized JPEG. */
export async function prepareEvidenceImage(file: File): Promise<File> {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > RESOURCE_LIMITS.maxBlueprintBytes) throw new Error("Choose a JPG, PNG, or WebP image of 10 MB or less.");
  const header = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const size = dimensions(header);
  if (!size || !size[0] || !size[1]) throw new Error("This image’s dimensions could not be read. Export it as a standard JPG or PNG.");
  if (size[0] * size[1] > 24_000_000) throw new Error("Choose an image below 24 megapixels so the workspace stays responsive.");
  const ratio = Math.min(1, RESOURCE_LIMITS.maxImageEdge / Math.max(...size));
  const width = Math.max(1, Math.round(size[0] * ratio));
  const height = Math.max(1, Math.round(size[1] * ratio));
  const bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("The evidence image could not be prepared.")), "image/jpeg", .82));
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  } finally { bitmap.close(); canvas.width = 1; canvas.height = 1; }
}
