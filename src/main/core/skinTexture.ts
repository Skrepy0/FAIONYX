/** Public texture downloads only; no account credentials are sent to texture hosts. */
import { translate as t } from '../../shared/i18n';

export const MAX_TEXTURE_BYTES = 1_490_000; // Fits the existing 2 MB data-URL cache limit.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function textureUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(t('skintex.error.url_must_be_http'));
  }
  // Older official profiles publish HTTP URLs for the same HTTPS texture service.
  // External providers still use their original, separately validated URL/policy.
  if (url.protocol === 'http:' && url.hostname === 'textures.minecraft.net' && !url.port) url.protocol = 'https:';
  return url.toString();
}

export function texturePngSize(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    bytes.length > MAX_TEXTURE_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error(t('skintex.error.response_not_png'));
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error(t('skintex.error.dimensions_invalid'));
  return { width, height };
}

export async function downloadTexture(
  value: string,
  fetcher: typeof fetch = fetch,
  validate?: (bytes: Buffer) => void
): Promise<{ dataUrl?: string; textureError?: string }> {
  let url: string;
  try {
    url = textureUrl(value);
  } catch {
    return { textureError: t('skintex.error.url_invalid') };
  }
  let reason = t('skintex.error.download_failed');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_TEXTURE_BYTES) {
        await response.body?.cancel();
        throw new Error(t('skintex.error.image_too_large'));
      }
      if (!response.body) throw new Error(t('skintex.error.response_empty'));
      const reader = response.body.getReader(),
        chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > MAX_TEXTURE_BYTES) {
            await reader.cancel();
            throw new Error(t('skintex.error.image_too_large'));
          }
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      texturePngSize(bytes);
      validate?.(bytes);
      return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    } catch (error) {
      reason =
        error instanceof Error && /^HTTP \d+$|^材质/.test(error.message) ? error.message : t('skintex.error.download_failed_or_timeout');
    }
  }
  return { textureError: reason + t('skintex.suffix.refresh_retry') };
}
