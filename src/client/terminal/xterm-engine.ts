// 保持叶子模块：不得反向导入终端视图、状态模型或插件入口。
export { Terminal } from '@xterm/xterm'
export { FitAddon } from '@xterm/addon-fit'
export { default as xtermCss } from '@xterm/xterm/css/xterm.css'
