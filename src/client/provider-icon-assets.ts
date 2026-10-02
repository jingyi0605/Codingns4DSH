import claudeCodeIcon from '../../assets/provider-icons/claude-code.png'
import codexIcon from '../../assets/provider-icons/codex.png'
import commandCodeIcon from '../../assets/provider-icons/command-code.svg'
import deepSeekHarnessIcon from '../../assets/provider-icons/deepseek-harness.svg'
import geminiIcon from '../../assets/provider-icons/gemini.png'
import grokIcon from '../../assets/provider-icons/grok.png'
import kimiIcon from '../../assets/provider-icons/kimi.png'
import openCodeIcon from '../../assets/provider-icons/opencode.png'
import piIcon from '../../assets/provider-icons/pi.svg'
import minimaxCodeIcon from '../../assets/provider-icons/minimax-code.svg'
import zcodeIcon from '../../assets/provider-icons/zcode.svg'
import codeBuddyIcon from '../../assets/provider-icons/codebuddy.svg'
import workBuddyIcon from '../../assets/provider-icons/workbuddy.svg'
import cursorCliIcon from '../../assets/provider-icons/cursor-cli.svg'
import kiroCliIcon from '../../assets/provider-icons/kiro-cli.svg'
import qoderIcon from '../../assets/provider-icons/qoder.svg'
import qoderCnIcon from '../../assets/provider-icons/qoder-cn.svg'
import antigravityIcon from '../../assets/provider-icons/antigravity.svg'
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
  mcode: minimaxCodeIcon,
  zcode: zcodeIcon,
  codebuddy: codeBuddyIcon,
  workbuddy: workBuddyIcon,
  'cursor-cli': cursorCliIcon,
  'kiro-cli': kiroCliIcon,
  qoder: qoderIcon,
  'qoder-cn': qoderCnIcon,
  antigravity: antigravityIcon,
})
