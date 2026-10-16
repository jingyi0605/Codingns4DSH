import { dshThemeColor as color } from '../theme.js'
import { uiFontSize } from '../font-scale.js'

/** Parent ModalAtoms/shortcut-rail layout, scoped to this plugin and mapped to DSH theme tokens. */
export const quickAppsCss = `
.codingns-quick-app-rail{width:100%;min-width:0;margin:0 0 6px;color:${color.labelPrimary};font-size:${uiFontSize(12)}}
.codingns-quick-app-rail .qa-rail-header{display:flex;align-items:center;gap:6px;min-height:28px;margin-bottom:4px}
.codingns-quick-app-rail[data-collapsed=true] .qa-rail-header{margin-bottom:0}
.codingns-quick-app-rail h2{margin:0;font-size:${uiFontSize(12)};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codingns-quick-app-rail .qa-count{color:${color.labelSecondary};font-size:${uiFontSize(11)}}
.codingns-quick-app-rail .qa-controls{display:flex;gap:2px;margin-left:auto}
.codingns-quick-app-rail .qa-control{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:0;border-radius:7px;background:transparent;color:${color.labelSecondary};cursor:pointer}
.codingns-quick-app-rail .qa-control svg{width:16px;height:16px;flex:none}
.codingns-quick-app-rail .qa-control:hover:not(:disabled),.codingns-quick-app-rail .qa-tile:hover:not(:disabled){background:${color.hoverBackground}}
.codingns-quick-app-rail button:disabled{opacity:.5;cursor:not-allowed}
.codingns-quick-app-rail button:focus-visible{outline:2px solid ${color.accent};outline-offset:-2px}
.codingns-quick-app-rail .qa-grid{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding-top:4px;max-height:min(35dvh,240px);overflow:auto;overscroll-behavior:contain}
.codingns-quick-app-rail .qa-shortcut{position:relative;min-width:0}
.codingns-quick-app-rail .qa-tile{display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;min-width:0;min-height:54px;padding:2px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.codingns-quick-app-rail .qa-tile[data-editing=true]{outline:1px dashed ${color.border};outline-offset:-1px;cursor:grab;touch-action:none;user-select:none;-webkit-touch-callout:none}
.codingns-quick-app-rail .qa-tile[data-dragging=true]{cursor:grabbing;background:${color.hoverBackground};outline:2px solid ${color.accent};opacity:.7}
.codingns-quick-app-rail .qa-tile[data-editing=true]{animation:qa-tile-shake .28s ease-in-out infinite alternate;transform-origin:50% 60%}
.codingns-quick-app-rail .qa-tile[data-dragging=true]{animation-play-state:paused}
.codingns-quick-app-rail .qa-shortcut:nth-child(even) .qa-tile[data-editing=true]{animation-delay:-.14s}
.codingns-quick-app-rail .qa-remove{position:absolute;top:0;right:max(0px,calc(50% - 24px));display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:2px;border:1px solid ${color.cardBackground};border-radius:50%;background:${color.error};color:#fff;cursor:pointer}
.codingns-quick-app-rail .qa-remove svg{width:12px;height:12px;flex:none}
.codingns-quick-app-rail .qa-remove:hover:not(:disabled){filter:brightness(1.15)}
@keyframes qa-tile-shake{from{transform:rotate(-2deg)}to{transform:rotate(2deg)}}
@media(prefers-reduced-motion:reduce){.codingns-quick-app-rail .qa-tile[data-editing=true]{animation:none}}
.codingns-quick-app-rail .qa-tile[data-unavailable=true]:not([data-editing=true]){opacity:.6}
.codingns-quick-app-rail .qa-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:9px;font-size:${uiFontSize(12)};font-weight:700}
.codingns-quick-app-rail .qa-tile strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${uiFontSize(10)};font-weight:600;line-height:1.4;max-width:100%}
.codingns-quick-app-rail .qa-unavailable{position:absolute;right:-2px;bottom:-2px;border-radius:50%;width:12px;height:12px;line-height:12px;font-size:10px;background:${color.pageBackground};color:${color.error}}
.codingns-quick-app-rail .qa-rail-notice{margin:4px 0 8px;font-size:${uiFontSize(11)};line-height:1.5;color:${color.labelSecondary};overflow-wrap:anywhere;max-height:72px;overflow:auto}
.codingns-quick-app-rail .qa-rail-notice[role=alert]{color:${color.error}}
.codingns-quick-app-rail[data-wide=false]{width:36px}
.codingns-quick-app-rail[data-wide=false] .qa-controls{flex-direction:column;margin:0 auto}
.codingns-quick-app-rail[data-wide=false] .qa-control{width:36px;height:32px}
.codingns-quick-app-rail[data-wide=false] .qa-grid{grid-template-columns:minmax(0,1fr)}
.codingns-quick-app-rail[data-wide=false] .qa-tile{min-height:36px;justify-content:center}
.codingns-quick-app-rail[data-wide=false] .qa-tile strong{display:none}
.codingns-quick-app-rail[data-wide=false] .qa-rail-notice{text-align:center}
@media(pointer:coarse){.codingns-quick-app-rail .qa-control{width:32px;height:32px}}
.codingns-quick-app-dialog{width:520px;max-width:100%;max-height:100%;color:${color.labelPrimary};font-size:${uiFontSize(14)};border-radius:var(--dsw-radius-panel,12px);background:${color.menuBackground}}
.codingns-quick-app-dialog .qa-content{min-height:0;flex:1}
.codingns-quick-app-dialog .qa-content>div:has(>.qa-body){min-height:0;flex:1;overflow:hidden;margin-top:8px}
.codingns-quick-app-dialog .qa-body{display:flex;flex-direction:column;gap:16px;min-height:0;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;padding:2px}
.codingns-quick-app-dialog .qa-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;width:100%}
.codingns-quick-app-dialog .qa-button{min-height:34px;height:auto;padding:7px 12px;border:0;border-radius:8px;background:transparent;color:${color.labelPrimary};font-size:${uiFontSize(13)};font-weight:500;line-height:1.4;box-shadow:none}
.codingns-quick-app-dialog .qa-button:hover:not(:disabled){background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-button.qa-danger{color:${color.error}}
.codingns-quick-app-dialog .qa-button.qa-primary{background:${color.primaryBackground};color:${color.primaryForeground}}
.codingns-quick-app-dialog .qa-button.qa-primary:hover:not(:disabled){background:${color.primaryHoverBackground}}
.codingns-quick-app-dialog button:disabled{opacity:.5;cursor:not-allowed}
.codingns-quick-app-dialog :is(button,select):focus-visible{outline:2px solid ${color.accent};outline-offset:-2px}
.codingns-quick-app-dialog .qa-help{margin:0;color:${color.labelSecondary};font-size:${uiFontSize(12)};line-height:1.6}
.codingns-quick-app-dialog .qa-notice{margin:0;color:${color.success};font-size:${uiFontSize(13)};line-height:1.5}
.codingns-quick-app-dialog .qa-notice[role=alert]{color:${color.error}}
.codingns-quick-app-dialog .qa-form{display:flex;flex-direction:column;gap:18px;min-width:0}
.codingns-quick-app-dialog .qa-field{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:${uiFontSize(12)};font-weight:500}
/* DSH Input paints its wrapper; the inner input must remain undecorated. */
.codingns-quick-app-dialog :is(.qa-input,.qa-select,.qa-file-input){box-sizing:border-box;width:100%;min-width:0;max-width:100%;height:40px;border:0;border-radius:8px;background:${color.surfaceSubtle};color:${color.labelPrimary};font:inherit;font-size:${uiFontSize(13)};font-weight:400}
.codingns-quick-app-dialog :is(.qa-input,.qa-select){padding:0 11px}
.codingns-quick-app-dialog .qa-input input{width:100%;min-width:0;padding:0;border:0;border-radius:0;outline:none;background:transparent;color:inherit;font:inherit;box-shadow:none}
.codingns-quick-app-dialog :is(.qa-input,.qa-file-input):focus-within{outline:2px solid ${color.accent};outline-offset:-2px}
.codingns-quick-app-dialog :is(.qa-input,.qa-file-input):has(input:disabled){opacity:.5}
.codingns-quick-app-dialog .qa-field .qa-help{font-weight:400}
.codingns-quick-app-dialog .qa-file-input{display:flex;align-items:center;gap:4px;padding-right:4px}
.codingns-quick-app-dialog .qa-file-input .qa-input{flex:1;width:0;background:transparent;outline:none;opacity:1}
.codingns-quick-app-dialog .qa-file-input .qa-browse{flex:none;min-height:32px;padding:6px 9px;white-space:nowrap;color:${color.accent}}
.codingns-quick-app-dialog .qa-workspace-picker{display:block;width:100%;min-width:0}
.codingns-quick-app-dialog .qa-workspace-trigger{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:9px 11px;text-align:left;border:0;border-radius:8px;background:${color.surfaceSubtle};color:${color.labelPrimary};font:inherit;cursor:pointer}
.codingns-quick-app-dialog .qa-workspace-trigger:hover:not(:disabled){background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-workspace-trigger>svg{flex:none}
:is(.codingns-quick-app-dialog,.codingns-quick-app-workspaces) .qa-workspace-label{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0;overflow:hidden}
:is(.codingns-quick-app-dialog,.codingns-quick-app-workspaces) .qa-workspace-name{font-size:${uiFontSize(13)};font-weight:500}
:is(.codingns-quick-app-dialog,.codingns-quick-app-workspaces) .qa-workspace-label small{color:${color.labelSecondary};font-size:${uiFontSize(11)};font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codingns-quick-app-workspaces{z-index:10002;width:min(440px,calc(100vw - 24px));max-width:calc(100vw - 24px);background:${color.menuBackground};color:${color.labelPrimary};border:1px solid ${color.menuBorder};border-radius:var(--dsw-radius-lg,12px);box-shadow:${color.prominentShadow}}
.codingns-quick-app-dialog.qa-file-picker{width:600px;height:min(560px,85dvh)}
.codingns-quick-app-dialog.qa-file-picker .qa-body{flex:1;gap:12px}
.codingns-quick-app-dialog .qa-file-location{display:flex;align-items:center;gap:10px}
.codingns-quick-app-dialog .qa-file-location>svg{flex:none;color:${color.labelSecondary}}
.codingns-quick-app-dialog .qa-file-toolbar{display:flex;align-items:center;gap:4px;min-width:0;padding:3px;border-radius:8px;background:${color.surfaceSubtle}}
.codingns-quick-app-dialog .qa-file-tool{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:${color.labelSecondary};cursor:pointer}
.codingns-quick-app-dialog .qa-file-breadcrumbs{display:flex;flex:1;min-width:0;overflow:auto;align-items:center;gap:2px}
.codingns-quick-app-dialog .qa-file-crumb{display:flex;align-items:center;gap:2px;flex:none;color:${color.labelSecondary}}
.codingns-quick-app-dialog .qa-file-breadcrumbs button{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:5px;background:transparent;color:${color.labelSecondary};padding:6px;font:inherit;font-size:${uiFontSize(12)};cursor:pointer}
.codingns-quick-app-dialog .qa-file-breadcrumbs button[aria-current]{color:${color.labelPrimary};font-weight:500}
.codingns-quick-app-dialog :is(.qa-file-tool,.qa-file-breadcrumbs button):hover:not(:disabled){background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-file-list{flex:1;min-height:100px;overflow:auto;padding:2px}
.codingns-quick-app-dialog .qa-file-empty{padding:32px 16px;text-align:center}
.codingns-quick-app-dialog .qa-file-row{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;font:inherit;font-size:${uiFontSize(13)};cursor:pointer}
.codingns-quick-app-dialog .qa-file-row svg{flex:none}
.codingns-quick-app-dialog .qa-file-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codingns-quick-app-dialog .qa-file-row:hover{background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-file-row[aria-pressed=true]{background:color-mix(in srgb,${color.accent} 12%,transparent);color:${color.accent}}
.codingns-quick-app-dialog .qa-selected-file{margin:0;min-height:20px;font-size:${uiFontSize(12)};color:${color.labelSecondary};overflow-wrap:anywhere}
.codingns-quick-app-dialog .qa-field-error{font-size:${uiFontSize(12)};font-weight:400;color:${color.error}}
.codingns-quick-app-dialog .qa-management{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;min-width:0}
.codingns-quick-app-dialog .qa-management .qa-actions{justify-content:flex-start}
.codingns-quick-app-dialog .qa-management:disabled{opacity:.5}
/* Native TextPreview/Browser panel geometry; public PathLabel, Tooltip and glyphs retain their own styles. */
.codingns-quick-app-dialog.qa-viewer{width:80vw;height:85dvh;max-height:100%;gap:0;padding:0;border-radius:var(--dsw-radius-panel,12px)}
.codingns-quick-app-dialog.qa-viewer.qa-maximized{width:100%;height:100%;border-radius:0}
[role=presentation]:has(>.qa-viewer.qa-maximized){padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)}
.codingns-quick-app-dialog.qa-view-confirm{height:auto;max-height:75dvh}
.codingns-quick-app-dialog .qa-view-surface{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;color:${color.labelPrimary};background:${color.pageBackground}}
.codingns-quick-app-dialog :is(.qa-view-titlebar,.qa-view-toolbar){display:flex;flex:none;align-items:center;gap:4px;box-sizing:border-box;height:38px;padding:0 6px 0 16px;border-bottom:.5px solid ${color.menuBorder}}
.codingns-quick-app-dialog .qa-view-titlebar{gap:8px}
.codingns-quick-app-dialog .qa-view-titlebar h2{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${uiFontSize(13)};font-weight:500}
.codingns-quick-app-dialog .qa-view-titlebar>svg{flex:none}
.codingns-quick-app-dialog .qa-view-tool{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:${color.labelSecondary};cursor:pointer}
.codingns-quick-app-dialog .qa-view-tool svg{width:15px;height:15px}
.codingns-quick-app-dialog .qa-view-tool:hover:not(:disabled){color:${color.labelPrimary};background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-view-tool:disabled{color:var(--dsw-alias-label-quaternary,GrayText);cursor:default}
.codingns-quick-app-dialog .qa-view-path{margin-right:12px;font-size:${uiFontSize(12)}}
.codingns-quick-app-dialog .qa-view-mode{flex:none;border:0;border-radius:var(--dsw-radius-sm,6px);padding:5px 8px;color:${color.labelSecondary};background:transparent;font:inherit;font-size:${uiFontSize(12)};cursor:pointer}
.codingns-quick-app-dialog .qa-view-mode:hover{background:${color.hoverBackground}}
.codingns-quick-app-dialog .qa-document-dirty{color:${color.labelSecondary};font-size:9px}
.codingns-quick-app-dialog .qa-document-markdown{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:12px 18px;overflow-wrap:anywhere}
.codingns-quick-app-dialog .qa-document-markdown img{max-width:100%}
.codingns-quick-app-dialog .qa-document-editor{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.codingns-quick-app-dialog .qa-editor-host{flex:1;min-height:0;overflow:hidden}
.codingns-quick-app-dialog .qa-editor-host .cm-editor{min-height:0;font-size:var(--dsh-content-font-size-secondary,${uiFontSize(13)})}
.codingns-quick-app-dialog .qa-view-progress{flex:none;height:2px;background:${color.accent};opacity:.7}
.codingns-quick-app-dialog .qa-view-status{flex:none;margin:0;padding:6px 12px;color:${color.labelSecondary};font-size:${uiFontSize(12)}}
.codingns-quick-app-dialog .qa-view-html .qa-view-toolbar{padding:5px 6px}
.codingns-quick-app-dialog .qa-view-address{flex:1;min-width:0;height:28px;box-sizing:border-box;padding:0 9px;border:.5px solid ${color.border};border-radius:var(--dsw-radius-sm,6px);background:${color.cardBackground};color:${color.labelPrimary};font:inherit;font-size:${uiFontSize(12)}}
.codingns-quick-app-dialog .qa-view-text-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;white-space:pre;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.codingns-quick-app-dialog .qa-view-text-body[data-wrap=true]{white-space:pre-wrap;overflow-wrap:anywhere}
.codingns-quick-app-dialog .qa-view-text-body pre{box-sizing:border-box;min-width:100%;min-height:100%;margin:0;padding:8px 18px;font-family:var(--dsw-font-mono,${color.codeFont});font-size:var(--dsh-content-font-size-secondary,${uiFontSize(13)});line-height:1.6;white-space:inherit}
.codingns-quick-app-dialog .qa-view-frame{flex:1;min-height:0;width:100%;border:0;background:${color.pageBackground}}
.codingns-quick-app-dialog .qa-view-error{flex:none;margin:0;padding:6px 12px;color:${color.error};background:color-mix(in srgb,${color.error} 8%,transparent);font-size:${uiFontSize(12)};line-height:1.5;overflow-wrap:anywhere}
@media(pointer:coarse){.codingns-quick-app-dialog :is(.qa-view-titlebar,.qa-view-toolbar){height:44px}.codingns-quick-app-dialog .qa-view-tool{width:40px;height:40px}}
@media(max-width:640px){
 [role=presentation]:has(>.codingns-quick-app-dialog){align-items:flex-end;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px)}
 .codingns-quick-app-dialog{width:100%;height:auto;max-height:100%;border-radius:16px 16px 0 0;padding-bottom:max(16px,env(safe-area-inset-bottom,0px))}
 .codingns-quick-app-dialog.qa-file-picker{width:100%;height:75dvh}
 .codingns-quick-app-dialog.qa-viewer{width:100%;height:100%;border-radius:0;padding-bottom:env(safe-area-inset-bottom,0px)}
 .codingns-quick-app-dialog .qa-button{min-height:40px}
 .codingns-quick-app-dialog .qa-actions>button{flex:1}
 .codingns-quick-app-dialog .qa-file-input .qa-browse{min-height:36px}
}
`
