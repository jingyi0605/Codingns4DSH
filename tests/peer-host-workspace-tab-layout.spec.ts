import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/** 使用独立无界面 Chromium 测布局，不连接或修改任何 DSH 实例。 */
const chromium = process.env.CODINGNS_TEST_CHROMIUM
const root = fileURLToPath(new URL('../', import.meta.url))

test('真实浏览器中长候选列表不会压扁已添加表格，旧样式也会被更新', { skip: chromium === undefined }, (context) => {
  const directory = mkdtempSync(join(root, 'data', 'peer-host-layout-'))
  try {
    // 源码只在内存转换，避免读取旧产物或为布局验证执行构建；仅替换颜色与翻译依赖。
    const moduleCode = browserModule('src/client/peer-host-workspace-tab.ts')
      .replace(/^import .*;\r?\n/gmu, '')
    const dictionaryCode = browserModule('src/client/locales/peerHostWorkspace.ts')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-label-tertiary:#888;--dsw-alias-border-l4:#555}
      body{margin:0;background:#222;font-family:sans-serif}
      [role=dialog]{display:flex;flex-direction:column;width:680px;height:500px}
      .ZuhsRW_editorScope{display:contents}
      .ZuhsRW_header{display:flex;flex-direction:column;flex:none;padding:16px 24px;gap:8px}
      .ZuhsRW_title{font-size:16px;line-height:24px;margin:0}
    </style><style data-plugin-css="codingns4dsh-peer-host-workspace-tab-style">.codingns4dsh-peer-host-tableWrap{overflow-x:auto}</style></head>
    <body><div role="dialog"><div class="ZuhsRW_editorScope"><div class="ZuhsRW_header"><h2 class="ZuhsRW_title">选择工作区目录</h2></div>
      <div class="ZuhsRW_crumbBar"></div><div class="ZuhsRW_content"></div><div class="ZuhsRW_footerBar"></div>
    </div></div><script type="module">
      ${dictionaryCode}
      const resolvePeerHostColor = () => '#52c41a';
      const resolveCodingNsTranslator = () => (key,args={}) => (zh[key] ?? key).replace(/\\{([^}]+)\\}/g,(_,name)=>String(args[name] ?? name));
      ${moduleCode}
      const workspaces=Array.from({length:15},(_,index)=>({workspaceId:'workspace-'+index,displayName:'项目 '+index,path:'/Users/dev/project-'+index,sessionCount:index+1}));
      const api={
        list:async()=>[{id:'peer-1',displayName:'Mac',status:'ready',visibleWorkspaceIds:workspaces.slice(0,3).map(w=>w.workspaceId)}],
        workspaceCandidates:async()=>workspaces,
        aggregate:async()=>[{targetHostId:'peer-1',availability:'ready',workspaces:workspaces.slice(0,3).map(w=>({...w,sessions:[],archivedSessions:[]}))}],
        setWorkspaceVisibility:async()=>undefined,
      };
      const controller=startPeerHostWorkspaceTab({api});
      const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
      document.querySelector('[role=tablist]').children[1].click();await settle();
      document.querySelector('[data-codingns-peer-host-tab-host]').click();await settle();
      const measure=()=>({
        wrapperHeight:document.querySelector('.codingns4dsh-peer-host-tableWrap').getBoundingClientRect().height,
        headerHeight:document.querySelector('.codingns4dsh-peer-host-table th').getBoundingClientRect().height,
        rowHeights:Array.from(document.querySelectorAll('[data-codingns-peer-host-tab-added-workspace]')).map(row=>row.getBoundingClientRect().height),
        actionsFit:Array.from(document.querySelectorAll('[data-codingns-peer-host-tab-remove-workspace]')).every(button=>{
          const action=button.getBoundingClientRect(),cell=button.parentElement.getBoundingClientRect();
          return action.width>0&&action.left>=cell.left&&action.right<=cell.right;
        }),
        scrollHeight:document.querySelector('.codingns4dsh-peer-host-panel').scrollHeight,
        clientHeight:document.querySelector('.codingns4dsh-peer-host-panel').clientHeight,
      });
      const style=document.querySelector('style[data-plugin-css="codingns4dsh-peer-host-workspace-tab-style"]');
      const fixedStyle=style.textContent;
      style.textContent=fixedStyle.replace('-tableWrap{flex:none;','-tableWrap{');
      const legacy=measure();style.textContent=fixedStyle;
      const fixed=measure();
      document.querySelector('[data-codingns-peer-host-tab-candidate]').click();await settle();
      const added=measure();
      document.querySelector('[data-codingns-peer-host-tab-remove-workspace]').click();await settle();
      const removed=measure();
      const restoredCandidate=Array.from(document.querySelectorAll('[data-codingns-peer-host-tab-candidate]')).some(button=>button.getAttribute('data-codingns-peer-host-tab-candidate')==='workspace-0');
      const output=document.createElement('pre');output.id='layout-result';output.textContent=JSON.stringify({legacy,fixed,added,removed,restoredCandidate});document.body.append(output);
      controller.dispose();
    </script></body></html>`
    const fixture = join(directory, 'layout.html')
    writeFileSync(fixture, html)
    const output = execFileSync(chromium!, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(directory, 'browser-profile')}`, '--virtual-time-budget=3000', '--dump-dom',
      pathToFileURL(fixture).href,
    ], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    const resultText = /<pre id="layout-result">(.*?)<\/pre>/su.exec(output)?.[1]
    assert.notEqual(resultText, undefined, '浏览器必须完成真实 DOM 渲染并返回布局结果')
    const result = JSON.parse(resultText!)
    context.diagnostic(`表格容器高度：旧规则 ${result.legacy.wrapperHeight}px，修复后 ${result.fixed.wrapperHeight}px；新增后 ${result.added.wrapperHeight}px`)
    assert.ok(result.legacy.wrapperHeight <= 2, '旧规则应复现只有边线的零高度表格')
    assert.ok(result.fixed.wrapperHeight > 100, '表头和三条记录必须完整占据高度')
    assert.ok(result.fixed.headerHeight > 0)
    assert.equal(result.fixed.rowHeights.length, 3)
    assert.ok(result.fixed.rowHeights.every((height: number) => height > 0))
    assert.equal(result.fixed.actionsFit, true, '最右侧操作列必须完整容纳移除按钮')
    assert.ok(result.fixed.scrollHeight > result.fixed.clientHeight, '长候选列表必须由整个面板滚动')
    assert.equal(result.added.rowHeights.length, 4, '新增工作区应立即成为可见表格行')
    assert.ok(result.added.rowHeights.every((height: number) => height > 0))
    assert.equal(result.added.actionsFit, true)
    assert.equal(result.removed.rowHeights.length, 3, '移除后表格立即减少一行')
    assert.equal(result.removed.actionsFit, true)
    assert.equal(result.restoredCandidate, true, '移除的工作区必须回到候选列表')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 浏览器夹具仅需要标准 JavaScript，转换结果不写入任何运行中实例的产物目录。 */
function browserModule(relativePath: string): string {
  return ts.transpileModule(readFileSync(join(root, relativePath), 'utf8'), {
    fileName: relativePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}
