import type { UiLang } from './i18n'
import koreanGuide from '../../../docs/EXTERNAL_TOOLS_AI.md?raw'
import englishGuide from '../../../docs/EXTERNAL_TOOLS_AI.en.md?raw'
import clientSource from '../../../examples/external-tool-lab/client.mjs?raw'
import exampleSource from '../../../examples/external-tool-lab/connect-example.mjs?raw'

// Only bundled public instructions and source code: no live discovery data or credentials.
const sourceFiles = `\n\n### client.mjs\n\n\`\`\`js\n${clientSource.trimEnd()}\n\`\`\`\n\n### connect-example.mjs\n\n\`\`\`js\n${exampleSource.trimEnd()}\n\`\`\`\n`
const guides = { ko: koreanGuide.trimEnd() + sourceFiles, en: englishGuide.trimEnd() + sourceFiles }

export function externalToolGuide(language: UiLang): string { return guides[language] }
