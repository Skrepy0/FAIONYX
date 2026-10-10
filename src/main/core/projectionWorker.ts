import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readProjection, stateText } from './projectionFormats';
import { analyzeProjection, convertProjection, versionName } from './projectionConversion';
import { translate as t } from '../../shared/i18n';
try {
  if (fs.statSync(workerData.file).size > 64 * 1024 * 1024) throw new Error(t('projectionworker.error.too_large'));
  const input = fs.readFileSync(workerData.file);
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  if (workerData.hash && hash !== workerData.hash) throw new Error(t('projectionworker.error.source_changed'));
  parentPort?.postMessage({ progress: 0.15, text: t('projectionworker.state.read_verify') });
  const p = readProjection(input, workerData.sourceFormat);
  parentPort?.postMessage({ progress: 0.45, text: t('projectionworker.state.inspect_regions') });
  if (workerData.action === 'metadata')
    parentPort?.postMessage({
      result: {
        blocks: p.regions.reduce((n, r) => {
          const air = r.palette.map((state) => ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(stateText(state)));
          for (const i of r.blocks) if (!air[i]) n++;
          return n;
        }, 0),
        dataVersion: p.dataVersion,
        gameVersion: versionName(p.dataVersion),
      },
    });
  else if (workerData.action === 'analyze')
    parentPort?.postMessage({ result: { ...analyzeProjection(p, workerData.format, workerData.version), sourceHash: hash } });
  else {
    const output = convertProjection(p, workerData.format, workerData.version, workerData.choices);
    parentPort?.postMessage({ progress: 0.85, text: t('projectionworker.state.reread_verify') });
    const reread = readProjection(output, workerData.format);
    if (reread.regions.reduce((n, r) => n + r.blocks.length, 0) < p.regions.reduce((n, r) => n + r.blocks.length, 0))
      throw new Error(t('projectionworker.error.block_count'));
    if (crypto.createHash('sha256').update(fs.readFileSync(workerData.file)).digest('hex') !== hash)
      throw new Error(t('projectionworker.error.source_changed_during'));
    parentPort?.postMessage({ result: output });
  }
} catch (e) {
  parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
