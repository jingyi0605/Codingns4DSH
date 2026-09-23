import claudeCodeIcon from '../../assets/provider-icons/claude-code.png'
import codexIcon from '../../assets/provider-icons/codex.png'
import commandCodeIcon from '../../assets/provider-icons/command-code.svg'
import deepSeekHarnessIcon from '../../assets/provider-icons/deepseek-harness.svg'
import geminiIcon from '../../assets/provider-icons/gemini.png'
import grokIcon from '../../assets/provider-icons/grok.png'
import kimiIcon from '../../assets/provider-icons/kimi.png'
import openCodeIcon from '../../assets/provider-icons/opencode.png'
import piIcon from '../../assets/provider-icons/pi.svg'
import { installProviderIcons } from './provider-icons.js'

/** 资产只在浏览器单文件入口中加载，由 tsdown 转成 data URL。 */
installProviderIcons({
  dsh: deepSeekHarnessIcon,
  'command-code': commandCodeIcon,
  'claude-code': claudeCodeIcon,
  kimi: kimiIcon,
  gemini: geminiIcon,
  pi: piIcon,
  codex: codexIcon,
  opencode: openCodeIcon,
  grok: grokIcon,
})
