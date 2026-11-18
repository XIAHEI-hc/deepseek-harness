/**
 * Markdown body rendering for plaza drafts: the text a skill provider serves to
 * the model once a version is published.
 *
 * The rendering stays out of the plugin entry so the entry exports only what
 * Cordis loading needs; the service and the same-package tests import it here.
 *
 * @module @deepseek-ai/dsh-skill-plaza/src/body
 */

import type { PlazaCheckableContent } from './presentation.ts'

/**
 * Render a stored draft as the markdown body a skill provider serves.
 * @param content - validated draft content.
 * @returns the complete skill body, newest section last.
 */
export function renderSkillBody(content: PlazaCheckableContent): string {
  const section = (heading: string, lines: readonly string[]): string[] => lines.length === 0
    ? []
    : [`## ${heading}`, ...lines, '']
  return [
    `# ${content.title}`,
    '',
    content.description,
    '',
    ...section('Inputs', content.inputs.map(input => `- ${input}`)),
    ...section('Steps', content.steps.map((step, index) => `${index + 1}. ${step}`)),
    ...section('Expected outputs', content.outputs.map(output => `- ${output}`)),
    ...section('Verification', content.verification === '' ? [] : [content.verification]),
    ...section('Failure handling', content.failureHandling === '' ? [] : [content.failureHandling]),
    ...section('Tool dependencies', content.toolDependencies.map(tool => `- \`${tool}\``)),
  ].join('\n').trimEnd() + '\n'
}
