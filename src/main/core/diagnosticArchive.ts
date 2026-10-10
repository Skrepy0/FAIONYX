import fs from 'node:fs';
import yazl from 'yazl';
import { redactDiagnosticPath, redactDiagnosticText } from './diagnostics';
import { translate as t } from '../../shared/i18n';

const MAX_LOG_BYTES = 16 * 1024 * 1024;

export interface DiagnosticManifestEntry {
  archivePath: string;
  source: string;
  status: 'included' | 'missing' | 'unreadable';
  originalBytes?: number;
  includedBytes?: number;
  modifiedAt?: string;
  truncated?: boolean;
  note?: string;
}

export interface DiagnosticSource {
  archivePath: string;
  source: string;
  missingPlaceholder?: boolean;
}

async function readTextTail(file: string): Promise<{
  text: string;
  originalBytes: number;
  includedBytes: number;
  modifiedAt: string;
  truncated: boolean;
}> {
  const stat = await fs.promises.stat(file);
  const includedBytes = Math.min(stat.size, MAX_LOG_BYTES);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(includedBytes);
    if (includedBytes > 0) await handle.read(buffer, 0, includedBytes, stat.size - includedBytes);
    const truncated = stat.size > includedBytes;
    return {
      text: `${truncated ? t('diagarchive.log_truncated', { bytes: includedBytes }) : ''}${buffer.toString('utf-8')}`,
      originalBytes: stat.size,
      includedBytes,
      modifiedAt: stat.mtime.toISOString(),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

async function addSanitizedLog(
  zip: yazl.ZipFile,
  files: DiagnosticManifestEntry[],
  spec: DiagnosticSource,
  secrets: string[]
): Promise<void> {
  const entry: DiagnosticManifestEntry = {
    archivePath: spec.archivePath,
    source: redactDiagnosticPath(spec.source),
    status: 'missing',
  };
  files.push(entry);
  try {
    const value = await readTextTail(spec.source);
    const text = redactDiagnosticText(value.text, secrets);
    zip.addBuffer(Buffer.from(text, 'utf-8'), spec.archivePath);
    Object.assign(entry, {
      status: 'included' as const,
      originalBytes: value.originalBytes,
      includedBytes: Buffer.byteLength(text),
      modifiedAt: value.modifiedAt,
      truncated: value.truncated,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      entry.status = 'unreadable';
      entry.note = redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets);
    }
    if (spec.missingPlaceholder) {
      zip.addBuffer(
        Buffer.from(entry.status === 'missing' ? t('diagarchive.entry_missing') : t('diagarchive.entry_unreadable')),
        spec.archivePath
      );
    }
  }
}

/**
 * 写入真正的 ZIP，并在完成前更新 manifest 的 included/missing 状态。
 * 任一打包错误会删除未完成目标，不留下损坏的诊断包。
 */
export async function writeDiagnosticArchive<T extends { files: DiagnosticManifestEntry[] }>(
  destination: string,
  manifest: T,
  sources: DiagnosticSource[],
  summary: string,
  secrets: string[] = []
): Promise<void> {
  const zip = new yazl.ZipFile();
  try {
    for (const source of sources) await addSanitizedLog(zip, manifest.files, source, secrets);
    zip.addBuffer(Buffer.from(redactDiagnosticText(summary, secrets), 'utf-8'), 'summary.txt');
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), 'manifest.json');
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(destination);
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      output.once('close', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      output.once('error', fail);
      zip.outputStream.once('error', fail);
      zip.outputStream.pipe(output);
      zip.end();
    });
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}
