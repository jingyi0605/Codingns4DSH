import { CODINGNS_VERSION } from '../shared/contracts/version.js'
import { PROVIDER_ICON_FILES, PROVIDER_ICON_PATH } from '../shared/provider-icon-resources.js'
import { installProviderIcons } from './provider-icons.js'

/** 保留同步查询接口；浏览器仅在实际显示图标时请求图片，版本变化自动更新缓存。 */
installProviderIcons(Object.fromEntries(Object.entries(PROVIDER_ICON_FILES)
  .map(([provider, filename]) => [provider, `${PROVIDER_ICON_PATH}${filename}?v=${encodeURIComponent(CODINGNS_VERSION)}`])))
