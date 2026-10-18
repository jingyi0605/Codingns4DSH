import type { CodingNsClientFeatureModule } from './types.js'
import { DEFAULT_FILE_MANAGEMENT_SETTINGS } from '../../shared/contracts/config.js'
import { startFileManagementDom } from '../file-management-dom.js'
import { FileManagementPanel } from './file-management-panel.js'
import { registerSessionChangedFilesView } from '../session-changed-files-view.js'
import { registerFileViewerCopyPathMenu } from '../file-viewer-copy-path-menu.js'
import { resolveCodingNsTranslator } from '../locale.js'
import { startHtmlWorkspaceFiles } from '../html-workspace-files.js'

/** descriptor 的 label/description 只是词典缺失时的兜底，取内置中文词典。 */
const fallbackT = resolveCodingNsTranslator()

/** 文件管理增强：只在模块启用期间挂载右键菜单和文本编辑器。 */
export const fileManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'fileManagement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: fallbackT('feature.fileManagement.label'),
      description: fallbackT('feature.fileManagement.description'),
      labelKey: 'feature.fileManagement.label',
      descriptionKey: 'feature.fileManagement.description',
      order: 40,
      defaultOpen: false,
    },
  },
  start(context) {
    const readOptions = () => {
      const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...context.services.settings.getSnapshot().value?.fileManagement }
      return { menuEnhancement: value.menuEnhancement, fileEditor: value.fileEditor, locale: context.services.locale }
    }
    const dom = startFileManagementDom(context.services.rpc, readOptions())
    context.resources.add(startHtmlWorkspaceFiles(context.services.rpc, context.services.locale))
    let disposeSessionView: (() => void) | undefined
    let disposeCopyPathMenu: (() => void) | undefined
    const slots = context.services.uiContext?.slots ?? context.services.slots
    const syncSessionView = (): void => {
      const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...context.services.settings.getSnapshot().value?.fileManagement }
      if (value.sessionChangedFiles && disposeSessionView === undefined) {
        disposeSessionView = registerSessionChangedFilesView(context.services.uiContext, context.services.rpc, context.services.remote, context.services.locale)
      } else if (!value.sessionChangedFiles && disposeSessionView !== undefined) {
        disposeSessionView()
        disposeSessionView = undefined
      }
    }
    const syncCopyPathMenu = (): void => {
      const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...context.services.settings.getSnapshot().value?.fileManagement }
      if (value.menuEnhancement && disposeCopyPathMenu === undefined) {
        disposeCopyPathMenu = registerFileViewerCopyPathMenu(slots, context.services.locale)
      } else if (!value.menuEnhancement && disposeCopyPathMenu !== undefined) {
        disposeCopyPathMenu()
        disposeCopyPathMenu = undefined
      }
    }
    syncSessionView()
    syncCopyPathMenu()
    const unsubscribe = context.services.settings.subscribe(() => {
      dom.setOptions(readOptions())
      syncSessionView()
      syncCopyPathMenu()
    })
    context.resources.add(unsubscribe)
    context.resources.add(dom.dispose)
    context.resources.add(() => disposeSessionView?.())
    context.resources.add(() => disposeCopyPathMenu?.())
  },
  settingsPanel: FileManagementPanel,
}
