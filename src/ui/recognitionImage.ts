/** Decode only raster previews; report-provided URLs never trigger external image requests. */
export function recognitionImageBlob(value: string): Blob | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match || !['image/png', 'image/jpeg', 'image/webp'].includes(match[1]) || value.length > 128 * 1024 * 1024)
    return null;
  try {
    const binary = atob(match[2]);
    return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1] });
  } catch {
    return null;
  }
}

export function recognitionFileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Error(`无法读取文件：${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
