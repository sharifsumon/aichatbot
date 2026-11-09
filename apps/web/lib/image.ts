/** Longest side, in pixels, of a product photo after shrinking. Messenger shows images far smaller. */
const MAX_SIDE = 1600;
/** Files at or under this size, and already small enough, are sent as they are. */
const SMALL_BYTES = 500 * 1024;

/**
 * Shrinks a photo in the browser before it is uploaded: phone photos are often
 * 3 to 5 MB and take a long time on a mobile connection. Returns the original
 * file when it is already small, or when the browser cannot shrink it.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_BYTES) return file;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return file;
    // JPEG has no transparency: paint white under PNG and WebP photos.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
