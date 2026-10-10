import type { DiagnosticFinding } from '../../shared/instanceCenter';
import { redactDiagnosticText } from './diagnostics';
import { translate as t } from '../../shared/i18n';
const RULES: Array<{
  rule: string;
  title: string;
  pattern: RegExp;
  advice: string;
  action?: DiagnosticFinding['action'];
  confidence: DiagnosticFinding['confidence'];
}> = [
  {
    rule: 'java-version',
    title: 'diagrule.java_version_title',
    pattern: /UnsupportedClassVersionError|class file version .*only recognizes|requires Java (?:version )?\d+/i,
    advice: 'diagrule.java_version_advice',
    action: 'java',
    confidence: 'certain',
  },
  {
    rule: 'java-argument',
    title: 'diagrule.java_argument_title',
    pattern: /Unrecognized VM option|Unrecognized option:|Invalid maximum heap size|Improperly specified VM option/i,
    advice: 'diagrule.java_argument_advice',
    confidence: 'certain',
  },
  {
    rule: 'memory',
    title: 'diagrule.memory_title',
    pattern: /OutOfMemoryError|Could not reserve enough space|Native memory allocation .*failed|There is insufficient memory/i,
    advice: 'diagrule.memory_advice',
    confidence: 'certain',
  },
  {
    rule: 'dependency',
    title: 'diagrule.dependency_title',
    pattern:
      /requires .*which is missing|requires .*which is not installed|Missing mandatory dependencies|ModResolutionException|Incompatible mod set/i,
    advice: 'diagrule.dependency_advice',
    action: 'mods',
    confidence: 'certain',
  },
  {
    rule: 'duplicate',
    title: 'diagrule.duplicate_title',
    pattern: /DuplicateModsFoundException|Duplicate mod(?:s| ID)?(?: found|:)|Found duplicate mods/i,
    advice: 'diagrule.duplicate_advice',
    action: 'mods',
    confidence: 'certain',
  },
  {
    rule: 'mod-version',
    title: 'diagrule.mod_version_title',
    pattern: /requires.*minecraft.*but|requires.*version.*but only|incompatible with.*version/i,
    advice: 'diagrule.mod_version_advice',
    action: 'mods',
    confidence: 'certain',
  },
  {
    rule: 'archive',
    title: 'diagrule.archive_title',
    pattern: /ZipException:.*(?:zip END header|error in opening zip|invalid)|Invalid or corrupt jarfile/i,
    advice: 'diagrule.archive_advice',
    action: 'files',
    confidence: 'possible',
  },
  {
    rule: 'permission',
    title: 'diagrule.permission_title',
    pattern: /AccessDeniedException|Permission denied|used by another process|being used by another process/i,
    advice: 'diagrule.permission_advice',
    confidence: 'certain',
  },
  {
    rule: 'disk',
    title: 'diagrule.disk_title',
    pattern: /No space left on device|There is not enough space on the disk|ENOSPC/i,
    advice: 'diagrule.disk_advice',
    confidence: 'certain',
  },
  {
    rule: 'graphics',
    title: 'diagrule.graphics_title',
    pattern: /GLFW error \d+|Failed to create OpenGL context|Pixel format not accelerated|does not support OpenGL/i,
    advice: 'diagrule.graphics_advice',
    confidence: 'certain',
  },
  {
    rule: 'native-arch',
    title: 'diagrule.native_arch_title',
    pattern: /wrong architecture|incompatible architecture|Can't load AMD 64-bit|mach-o.*(?:arm64|x86_64)|Bad CPU type in executable/i,
    advice: 'diagrule.native_arch_advice',
    action: 'java',
    confidence: 'possible',
  },
];
export function analyzeDiagnosticText(text: string): DiagnosticFinding[] {
  const lines = redactDiagnosticText(text).split(/\r?\n/),
    result: DiagnosticFinding[] = [];
  for (const rule of RULES) {
    const index = lines.findIndex((line) => rule.pattern.test(line));
    if (index < 0) continue;
    const evidence = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 4))
      .join('\n')
      .slice(0, 2000);
    result.push({
      rule: rule.rule,
      title: t(rule.title),
      confidence: rule.confidence,
      evidence,
      advice: t(rule.advice),
      action: rule.action,
    });
  }
  if (!result.length && text.trim())
    result.push({
      rule: 'unknown',
      title: t('diagrule.unknown_title'),
      confidence: 'unknown',
      evidence: t('diagrule.unknown_evidence'),
      advice: t('diagrule.unknown_advice'),
    });
  return result;
}
