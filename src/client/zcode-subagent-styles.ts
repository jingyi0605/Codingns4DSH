/** Native subagent menu: neutral rings, two-line rows and a shared metric column. */
export const zcodeSubagentStyles = `
.codingns-workflow-trigger{display:inline-flex;align-items:center;gap:4px;flex:none;min-height:28px;padding:3px 4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,GrayText);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.codingns-workflow-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}
.codingns-workflow-activity{display:inline-grid;place-items:center;flex:none;width:14px;height:14px}
.codingns-workflow-compact-icon{display:block}
.codingns-workflow-dot{display:block;width:16px;height:16px}
@keyframes codingns-workflow-pulse{50%{opacity:.4}}
.codingns-subagents{box-sizing:border-box;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,CanvasText)}
.codingns-subagents *{box-sizing:border-box}
.codingns-subagents button{font-family:inherit;color:inherit;margin:0;appearance:none}
.codingns-subagents button:disabled{cursor:default;opacity:.45}
.codingns-subagents button:focus-visible,.codingns-subagents summary:focus-visible,.codingns-workflow-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3979d4));outline-offset:2px}
.codingns-cli-dialog.codingns-subagents-dialog[open]{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);overflow:hidden}
.codingns-subagents__dialoghead{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:16px 20px;border-bottom:.5px solid var(--dsw-alias-border-l3,#d9d9d9)}
.codingns-subagents__dialoghead>*{grid-row:1}
.codingns-subagents__dialogtitle{margin:0;font-size:16px;line-height:24px;font-weight:600;min-width:0}
.codingns-subagents__dialogcontent{overflow:auto;min-height:0;overscroll-behavior:contain;scrollbar-gutter:stable}
.codingns-subagents__dialogbody{padding:18px 20px 24px;min-width:0}
.codingns-subagents__dialogbody[hidden]{display:none}
.codingns-subagents__toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:8px;margin-bottom:20px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;line-height:18px}
.codingns-subagents__toolbar p{margin:0;overflow-wrap:anywhere}
.codingns-subagents__overview{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
.codingns-subagents__group{min-width:0}
.codingns-subagents__grouphead{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;margin-bottom:10px}
.codingns-subagents__grouphead>*{grid-row:1}
.codingns-subagents__grouptitle{margin:0;font-size:13px;line-height:20px;font-weight:600}
.codingns-subagents__groupcount{justify-self:start;color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;font-variant-numeric:tabular-nums}
.codingns-subagents__grouphint{color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px}
.codingns-subagents__runlist{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.codingns-subagents__card{min-width:0;border:.5px solid var(--dsw-alias-border-l3,#d9d9d9);border-radius:var(--dsw-radius-md,12px);overflow:hidden}
.codingns-subagents__header{display:grid;grid-template-columns:8px minmax(0,1fr) auto 16px;align-items:center;column-gap:10px;row-gap:4px;width:100%;padding:12px 14px;border:0;background:transparent;text-align:left;cursor:pointer}
.codingns-subagents__header:hover,.codingns-subagents__steprow:hover,.codingns-subagents__row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
.codingns-subagents__dot{width:6px;height:6px;border-radius:50%;grid-row:1}
.codingns-subagents__title{grid-column:2;grid-row:1;min-width:0;font-size:13px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.codingns-subagents__status{font-size:12px;line-height:18px;white-space:nowrap;font-weight:400}
.codingns-subagents__header>.codingns-subagents__status{grid-column:3;grid-row:1}
.codingns-subagents__summary{grid-column:2 / 4;grid-row:2;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.codingns-subagents__chevron{width:16px;height:16px;color:var(--dsw-alias-label-tertiary,GrayText);transition:transform .15s}
.codingns-subagents__header>.codingns-subagents__chevron{grid-column:4;grid-row:1 / 3;align-self:center}
.codingns-subagents__chevron[data-open=true]{transform:rotate(90deg)}
.codingns-subagents__button{display:inline-grid;grid-auto-flow:column;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.codingns-subagents__button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.codingns-subagents__button--icon{width:28px;padding:0}
.codingns-subagents__cardbody{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin:0 14px;padding:8px 0 14px;border-top:.5px solid var(--dsw-alias-border-l3,#d9d9d9)}
.codingns-subagents__steps,.codingns-subagents__rows{display:grid;grid-template-columns:minmax(0,1fr)}
.codingns-subagents__step+.codingns-subagents__step{border-top:.5px solid var(--dsw-alias-border-l3,#d9d9d9)}
.codingns-subagents__steprow{display:grid;grid-template-columns:8px minmax(0,1fr) auto 16px;align-items:center;gap:10px;width:100%;min-height:40px;padding:8px 4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;text-align:left;cursor:pointer}
.codingns-subagents__steprow>*{grid-row:1}
.codingns-subagents__steplabel{min-width:0;font-size:13px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.codingns-subagents__count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,GrayText);font-variant-numeric:tabular-nums;white-space:nowrap}
.codingns-subagents__step>.codingns-subagents__rows{margin:0 0 8px 7px;padding-left:14px;border-left:.5px solid var(--dsw-alias-border-l3,#d9d9d9)}
.codingns-subagents__row{display:grid;grid-template-columns:8px minmax(0,1fr) auto 16px;align-items:center;gap:10px;width:100%;padding:9px 4px;min-height:48px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;text-align:left;cursor:pointer}
.codingns-subagents__row>*{grid-row:1}
.codingns-subagents__rowdot{width:6px;height:6px;border-radius:50%}
.codingns-subagents__rowmain{min-width:0}
.codingns-subagents__rowtitle{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.codingns-subagents__rowmeta{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.codingns-subagents__block{padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3,#d9d9d9)}
.codingns-subagents__section{margin:0;min-width:0}
.codingns-subagents__section>summary{font-weight:500}
.codingns-subagents__section[open]>summary{margin-bottom:8px}
.codingns-subagents__sectionhead{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:8px;font-size:12px;line-height:18px}
.codingns-subagents__sectiontitle{font-weight:500}
.codingns-subagents__sectionmeta{color:var(--dsw-alias-label-tertiary,GrayText)}
.codingns-subagents__artifacts{display:grid;gap:8px;margin-top:8px;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))}
.codingns-subagents__artifact{display:grid;gap:3px;border-radius:var(--dsw-radius-sm,8px);padding:10px 12px;min-width:0;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}
.codingns-subagents__artifactname{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.codingns-subagents__artifactmeta,.codingns-subagents__note,.codingns-subagents__entrymeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere}
.codingns-subagents__note{margin:6px 0 0}
.codingns-subagents__pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-height:320px;overflow:auto;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:12px;line-height:20px}
.codingns-subagents__disabled{color:var(--dsw-alias-state-error-primary,#b42318)}
.codingns-subagents__headline{display:grid;grid-template-columns:8px minmax(0,1fr) auto auto;align-items:center;gap:10px}
.codingns-subagents__headdot{width:6px;height:6px;border-radius:50%}
.codingns-subagents__detailtitle{min-width:0;font-size:14px;font-weight:600;line-height:22px;overflow-wrap:anywhere}
.codingns-subagents__metarow{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:4px 20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,GrayText);font-variant-numeric:tabular-nums}
.codingns-subagents__metarow>span{min-width:0;overflow-wrap:anywhere}
.codingns-subagents__detail{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:760px;margin:auto}
.codingns-subagents__entry{margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3,#d9d9d9);border-radius:var(--dsw-radius-sm,8px);min-width:0}
.codingns-subagents__entrysummary{cursor:pointer;font-size:12px;line-height:20px;overflow-wrap:anywhere}
.codingns-subagents__bubble{display:grid;gap:6px;margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);min-width:0;overflow-wrap:anywhere}
.codingns-subagents__bubble--user{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}
.codingns-subagents__back{margin-bottom:16px}
/* Match DSH's subagent list surfaces and density, including its neutral activity ring. */
.codingns-workflow-trigger{gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary,GrayText)}
.codingns-workflow-trigger>.codingns-subagents__chevron{width:12px;height:12px}
.codingns-subagents-menu{position:fixed;inset:auto;margin:0;padding:8px;border:.5px solid var(--dsw-alias-border-l3,#555);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-3,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-elevation-prominent,0 8px 32px #0003);overflow:auto;overscroll-behavior:contain;z-index:1000}
.codingns-subagents-menu[open]{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
.codingns-subagents-menu .codingns-subagents__dialoghead{padding:2px 6px 6px;border:0;gap:2px}
.codingns-subagents-menu .codingns-subagents__dialogtitle{font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary,GrayText)}
.codingns-subagents-menu .codingns-subagents__dialogbody{padding:0}
.codingns-subagents-menu .codingns-subagents__toolbar{display:none}
.codingns-subagents-menu .codingns-subagents__dialogcontent{scrollbar-gutter:auto}
.codingns-subagents [hidden]{display:none!important}
.codingns-subagents__overview{gap:14px}
.codingns-subagents__grouphead{display:grid;grid-template-columns:18px auto 14px minmax(0,1fr);align-items:center;gap:7px;width:100%;margin:0 0 4px;padding:4px 8px;min-height:32px;border:0;background:transparent;text-align:left;cursor:pointer;border-radius:8px}
.codingns-subagents__grouphead:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.codingns-subagents__grouptitle{font-size:14px;line-height:22px;font-weight:500;white-space:nowrap}
.codingns-subagents__grouphead>.codingns-subagents__chevron[data-open=true]{transform:rotate(-90deg)}
.codingns-subagents__runlist{gap:0;padding:4px;background:transparent;border-radius:var(--dsw-radius-md,12px)}
.codingns-subagents__card{border:0;border-radius:8px;overflow:hidden}
.codingns-subagents__header{grid-template-columns:18px minmax(0,1fr) 76px 14px;column-gap:8px;row-gap:0;padding:10px 8px;min-height:64px}
.codingns-subagents__title{font-size:14px;line-height:22px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.codingns-subagents__summary{font-size:12px;line-height:20px;grid-column:2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.codingns-subagents__header>.codingns-subagents__stateicon{grid-column:1;grid-row:1;align-self:center}
.codingns-subagents__header>.codingns-subagents__metrics{grid-column:3;grid-row:1 / 3}
.codingns-subagents__stateicon{display:block;width:18px;height:18px;color:var(--dsw-alias-label-tertiary,GrayText);flex:none}
.codingns-workflow-dot>.codingns-subagents__stateicon{width:16px;height:16px}
.codingns-subagents__stateicon[data-failed=true]{color:var(--dsw-alias-state-warning-primary,#d99a00)}
.codingns-subagents__spinner{transform-origin:center;animation:codingns-subagents-spin 1.2s linear infinite}
@keyframes codingns-subagents-spin{to{transform:rotate(360deg)}}
.codingns-subagents__row{grid-template-columns:18px minmax(0,1fr) 76px 14px;column-gap:8px;row-gap:0;padding:10px 8px;min-height:64px}
.codingns-subagents__rowmain{display:block;overflow:hidden}
.codingns-subagents-menu .codingns-subagents__row>.codingns-subagents__stateicon{align-self:start;margin-top:2px}
.codingns-subagents__rowtitle{display:block;white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:22px;font-weight:500;overflow:hidden}
.codingns-subagents__rowmeta{white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:20px;margin:0;overflow:hidden}
.codingns-subagents__metrics{display:grid;grid-template-columns:minmax(0,1fr);gap:0;text-align:right;align-self:center;color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}
.codingns-subagents__metrics>span{display:block}
.codingns-subagents__fold{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:7px;width:100%;min-height:42px;padding:8px;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#8881);color:var(--dsw-alias-label-secondary,GrayText)!important;text-align:left;cursor:pointer;font-size:14px;line-height:22px}
.codingns-subagents__fold:hover{background:var(--dsw-alias-interactive-bg-active,#8882)}
.codingns-subagents__ended{margin-top:4px;min-width:0}
.codingns-subagents__native-artifacts{margin:8px;padding:4px 0}
.codingns-subagents__cardbody{margin:0 8px 4px 16px;padding:0 0 6px 8px;border:0;border-left:.5px solid var(--dsw-alias-border-l3,#8883);gap:8px;container:codingns-workflow / inline-size}
.codingns-subagents__steprow{grid-template-columns:18px minmax(0,1fr) auto 14px;gap:8px;min-height:38px}
.codingns-subagents__step+.codingns-subagents__step{border:0}
.codingns-subagents__step>.codingns-subagents__rows{margin:0;padding:0;border:0}
.codingns-subagents__step .codingns-subagents__rowtitle{font-size:13px}
/* Each phase keeps its own participants; wrap from three columns to two to one. */
.codingns-subagents__parallel{grid-template-columns:minmax(0,1fr);gap:8px;padding:4px 0}
.codingns-subagents__parallel>.codingns-subagents__row{grid-template-columns:18px minmax(0,1fr) 14px;grid-template-rows:minmax(58px,1fr) auto;gap:6px;min-width:0;min-height:108px;padding:10px;border:.5px solid var(--dsw-alias-border-l3,#8883);background:var(--dsw-alias-interactive-bg-hover,#8881);align-items:start}
.codingns-subagents__parallel>.codingns-subagents__row:hover{background:var(--dsw-alias-interactive-bg-active,#8882)}
.codingns-subagents__parallel>.codingns-subagents__row>.codingns-subagents__stateicon{grid-column:1;grid-row:1}
.codingns-subagents__parallel>.codingns-subagents__row>.codingns-subagents__rowmain{grid-column:2;grid-row:1}
.codingns-subagents__parallel>.codingns-subagents__row>.codingns-subagents__chevron{grid-column:3;grid-row:1;margin-top:2px}
.codingns-subagents__parallel .codingns-subagents__rowtitle{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.codingns-subagents__parallel .codingns-subagents__rowmeta{font-size:12px;line-height:18px;margin-top:2px}
.codingns-subagents__parallel>.codingns-subagents__row>.codingns-subagents__metrics{grid-column:2 / 4;grid-row:2;grid-template-columns:auto minmax(0,1fr);gap:8px;text-align:left;width:100%;font-size:12px;line-height:18px}
.codingns-subagents__parallel .codingns-subagents__metrics>span:last-child{text-align:right}
@container codingns-workflow (min-width:500px){.codingns-subagents__parallel:has(> :nth-child(2)){grid-template-columns:repeat(2,minmax(0,1fr))}}
@container codingns-workflow (min-width:780px){.codingns-subagents__parallel:has(> :nth-child(3)){grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:460px){
 .codingns-subagents__dialoghead{padding:10px 12px;gap:4px}
 .codingns-subagents__dialogtitle{font-size:15px}
 .codingns-subagents__dialogbody{padding:14px 12px 24px}
 .codingns-subagents__toolbar{grid-template-columns:minmax(0,1fr);gap:4px;margin-bottom:16px}
 .codingns-subagents__grouphead{gap:6px}
 .codingns-subagents__grouphint{font-size:11px}
 .codingns-subagents__header{padding:12px 10px;gap:4px 8px}
 .codingns-subagents__cardbody{margin:0 10px}
 .codingns-subagents__headline{grid-template-columns:8px minmax(0,1fr) auto}
 .codingns-subagents__headline>.codingns-subagents__button{grid-column:2 / 4;justify-self:start}
 .codingns-subagents__button{min-height:36px}
 .codingns-subagents__button--icon{width:36px}
 .codingns-subagents__steprow{min-height:44px}
 .codingns-subagents__row{column-gap:8px;min-height:52px}
}
@container(max-width:460px){.codingns-workflow-trigger{box-sizing:border-box;width:28px;height:28px;padding:0;justify-content:center}.codingns-workflow-count{display:none}}
@media(max-width:460px){.codingns-subagents__header,.codingns-subagents__rows:not(.codingns-subagents__parallel)>.codingns-subagents__row{grid-template-columns:16px minmax(0,1fr) 66px 12px;column-gap:6px}.codingns-subagents__title,.codingns-subagents__rowtitle{font-size:13px}.codingns-subagents__metrics{font-size:11px}.codingns-subagents-menu .codingns-subagents__button{min-height:32px}}
@media(prefers-reduced-motion:reduce){.codingns-subagents__spinner{animation:none}.codingns-subagents__chevron{transition:none}}
`
