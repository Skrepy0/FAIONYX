import { app } from 'electron';
import path from 'node:path';
import { ExitJournal } from './exitJournal';
import { launcherLogWarn } from './launcherLog';
import { translate as t } from '../../shared/i18n';
let journal: ExitJournal | undefined;
export function exitHistory() {
  return (journal ??= new ExitJournal(path.join(app.getPath('userData'), 'exit-history.json')));
}
export function rememberExit<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch (error) {
    launcherLogWarn('exit-history', t('exithistory.log.save_failed'), error);
    return undefined;
  }
}
