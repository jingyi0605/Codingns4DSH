import { clampDesktopAssistantBounds } from '../../shared/desktop-assistant.js'

/** 交给 Desktop 的 open-url 入口恢复主窗口；单纯激活进程不会取消窗口最小化。 */
export function buildMacDesktopFocusScript(): string {
  return String.raw`
var focusingDesktop=false
function focusDesktop(){
 if(focusingDesktop)return
 var desktop=$.NSRunningApplication.runningApplicationWithProcessIdentifier(parentPid)
 if(parentPid<=0||desktop.isNil()||desktop.terminated||desktop.bundleURL.isNil())throw new Error('Desktop application is unavailable')
 var configuration=$.NSWorkspaceOpenConfiguration.configuration
 configuration.setActivates(true);configuration.setCreatesNewApplicationInstance(false)
 configuration.setAllowsRunningApplicationSubstitution(false)
 configuration.setPromptsUserIfNeeded(false)
 focusingDesktop=true
 try{
  // 明确指定当前父进程的应用包，避免系统协议默认值指向另一份 Desktop。
  $.NSWorkspace.sharedWorkspace.openURLsWithApplicationAtURLConfigurationCompletionHandler(
   $([$.NSURL.URLWithString('dsh://open')]),desktop.bundleURL,configuration,safe(function(application,error){
    focusingDesktop=false
    if(!error.isNil()){emit({ev:'error',message:'Desktop restore: '+ObjC.unwrap(error.localizedDescription)});return}
    emit({ev:'open'})
   }))
 }catch(error){focusingDesktop=false;throw error}
}
`.trim()
}

/** Cocoa/WKWebView 伴随进程；stdout 只传 JSON Lines，原生异常转为明确失败事件。 */
export function buildMacAssistantScript(): string {
  return String.raw`
ObjC.import('Cocoa')
ObjC.import('WebKit')
var out=$.NSFileHandle.fileHandleWithStandardOutput,NL=String.fromCharCode(10)
function emit(m){out.writeData($(JSON.stringify(m)+NL).dataUsingEncoding($.NSUTF8StringEncoding))}
function safe(fn){return function(){try{return fn.apply(null,arguments)}catch(e){emit({ev:'error',message:String(e)})}}}
var app=$.NSApplication.sharedApplication
app.setActivationPolicy(1)
var win=$.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0,0,144,156),128,2,false)
win.setOpaque(false);win.setBackgroundColor($.NSColor.clearColor);win.setHasShadow(false)
win.setLevel(3);win.setCollectionBehavior(1|16|256);win.setHidesOnDeactivate(false)
var visible=false,drag=false,lastMouse=null,parentPid=0,origin='',positioned=false
${buildMacDesktopFocusScript()}
var clampBounds=${clampDesktopAssistantBounds.toString()}
function moved(){var f=win.frame;emit({ev:'moved',x:f.origin.x,y:f.origin.y,width:f.size.width,height:f.size.height})}
function clamp(){
 var f=win.frame,screens=$.NSScreen.screens,areas=[]
 for(var i=0;i<screens.count;i++){var a=screens.objectAtIndex(i).visibleFrame;areas.push({x:a.origin.x,y:a.origin.y,width:a.size.width,height:a.size.height})}
 var next=clampBounds({x:f.origin.x,y:f.origin.y,width:f.size.width,height:f.size.height},areas)
 win.setFrameDisplay($.NSMakeRect(next.x,next.y,next.width,next.height),true)
}
function bounds(m){
 var f=win.frame,w=Math.max(72,Math.min(320,Number(m.width)||144)),h=Math.max(78,Math.min(480,Number(m.height)||156))
 var area=$.NSScreen.mainScreen.visibleFrame
 var x=positioned?f.origin.x:area.origin.x+area.size.width-w-24,y=positioned?f.origin.y:area.origin.y+24
 if(m.bounds&&Number.isFinite(m.bounds.x)&&Number.isFinite(m.bounds.y)){x=m.bounds.x;y=m.bounds.y}
 win.setFrameDisplay($.NSMakeRect(x,y,w,h),true);positioned=true;clamp()
}
function endDrag(){if(!drag)return;drag=false;clamp();moved()}
var config=$.WKWebViewConfiguration.alloc.init,controller=$.WKUserContentController.alloc.init
// JXA 注册类不返回类对象；WebKit 协议元数据也并非所有系统都可见。
// 显式声明代理方法签名，注册后通过 $ 查找类，由 WebKit 按选择器调用。
ObjC.registerSubclass({name:'CodingNsAssistantBridge',methods:{'userContentController:didReceiveScriptMessage:':{types:['void',['id','id']],implementation:safe(function(c,m){
 if(!m.frameInfo.isMainFrame)return
 var msg=JSON.parse(ObjC.unwrap(m.body))
 if(msg.type==='ready')emit({ev:'loaded'})
 else if(msg.type==='error')emit({ev:'error',message:String(msg.message).slice(0,500)})
 else if(msg.type==='drag-start'){drag=true;lastMouse=$.NSEvent.mouseLocation}
 else if(msg.type==='drag-end')endDrag()
 else if(msg.type==='open')focusDesktop()
})}}})
var bridgeHandler=$.CodingNsAssistantBridge.alloc.init
controller.addScriptMessageHandlerName(bridgeHandler,$('assistant'));config.setUserContentController(controller)
config.setWebsiteDataStore($.WKWebsiteDataStore.nonPersistentDataStore)
var web=$.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0,0,144,156),config)
web.setValueForKey($.NSNumber.numberWithBool(false),'drawsBackground');win.setContentView(web)
ObjC.registerSubclass({name:'CodingNsAssistantNavigation',methods:{
 'webView:decidePolicyForNavigationAction:decisionHandler:':{types:['void',['id','id','id']],implementation:safe(function(w,a,done){
  var policy=0
  try{var url=ObjC.unwrap(a.request.URL.absoluteString);policy=url.indexOf(origin+'/')===0?1:0}
  finally{
   // block 的隐含参数只有自身，没有 Objective-C 方法的 selector。
   // 用 NSInvocation 按 void (^)(NSInteger) 签名调用，不能把它当 JS 函数。
   var invocation=$.NSInvocation.invocationWithMethodSignature($.NSMethodSignature.signatureWithObjCTypes('v@?q')),argument=Ref('long')
   argument[0]=policy;invocation.setTarget(done);invocation.setArgumentAtIndex(argument,1);invocation.invoke
  }
 })},
 'webView:didFailProvisionalNavigation:withError:':{types:['void',['id','id','id']],implementation:safe(function(w,n,e){emit({ev:'error',message:'navigation: '+e.code+' '+ObjC.unwrap(e.localizedDescription)})})},
 'webView:didFailNavigation:withError:':{types:['void',['id','id','id']],implementation:safe(function(w,n,e){emit({ev:'error',message:'navigation: '+e.code+' '+ObjC.unwrap(e.localizedDescription)})})},
 'webViewWebContentProcessDidTerminate:':{types:['void',['id']],implementation:safe(function(w){emit({ev:'error',message:'webview process terminated'})})}
}})
var navigation=$.CodingNsAssistantNavigation.alloc.init;web.setNavigationDelegate(navigation)
$.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(1/60,true,safe(function(){
 if(!drag)return;if(($.NSEvent.pressedMouseButtons&1)===0||!visible){endDrag();return}
 var p=$.NSEvent.mouseLocation,f=win.frame;win.setFrameOrigin($.NSMakePoint(f.origin.x+p.x-lastMouse.x,f.origin.y+p.y-lastMouse.y));lastMouse=p
}))
$.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock($.NSApplicationDidChangeScreenParametersNotification,$(),$.NSOperationQueue.mainQueue,safe(function(){clamp();moved()}))
function handle(m){
 if(m.cmd==='quit'){app.terminate($());return}
 if(m.cmd==='hide'){endDrag();win.orderOut($());visible=false;return}
 if(m.cmd==='load'){
  parentPid=Number(m.parentPid)||0;bounds(m)
  var url=$.NSURL.URLWithString($(String(m.url)));origin=String(m.url).split('/').slice(0,3).join('/')
  web.loadRequest($.NSURLRequest.requestWithURL(url));return
 }
 if(m.cmd==='show'){if(!drag)bounds(m);if(!visible){win.orderFrontRegardless;visible=true}emit({ev:'shown'});return}
}
var stdin=$.NSFileHandle.fileHandleWithStandardInput,buf='',pending=$.NSMutableData.data
$.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock($.NSFileHandleDataAvailableNotification,stdin,$.NSOperationQueue.mainQueue,safe(function(){
 var data=stdin.availableData;if(data.length===0){app.terminate($());return}
 // 管道可能在中文字节中间分块，完整 UTF-8 到达前保留原始数据。
 pending.appendData(data);if(pending.length+buf.length>65536)throw new Error('command too large')
 var decoded=$.NSString.alloc.initWithDataEncoding(pending,$.NSUTF8StringEncoding)
 if(decoded.isNil()){stdin.waitForDataInBackgroundAndNotify;return}
 buf+=decoded.js;pending.setLength(0)
 var i;while((i=buf.indexOf(NL))>=0){var line=buf.slice(0,i);buf=buf.slice(i+1);handle(JSON.parse(line))}
 stdin.waitForDataInBackgroundAndNotify
}))
stdin.waitForDataInBackgroundAndNotify
emit({ev:'ready'})
app.run
`.trim()
}
