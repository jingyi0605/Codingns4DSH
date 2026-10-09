/**
 * 基于 MIT 上游窗口实现改造；C# 保持 ASCII，兼容 PowerShell 5.1 的编译器与编码。
 * 点击时以当前 Desktop 可执行文件触发单实例入口，让壳负责恢复、显示和聚焦主窗口，
 * 避免依赖标题栏样式或误选辅助窗口。只授权父进程取得前台，并清除继承的 Node 模式。
 */
const CS = String.raw`
using System;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

public static class PetAgent {
  static Window win;
  static WebView2CompositionControl web;
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static string origin = "", userData = "";
  static int parentPid;
  static bool positioned;
  static double avatarX, avatarY, avatarWidth = 144, avatarHeight = 156;
  static double noticeY, noticeHeight, captionY, captionHeight;
  static Dictionary<string, object> lastBounds;
  static bool loaded = false;
  static bool active = false;
  static bool dragging = false;
  static DispatcherTimer dragTimer;
  static DispatcherTimer appStateTimer;
  static bool appStateKnown = false;
  static bool appStateActive = false;
  static POINT lastCursor;
  static DateTime lastBoundsEvent = DateTime.MinValue;
  static DateTime lastFocusRequest = DateTime.MinValue;
  static object sync = new object();
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  static void Emit(object value) { lock(sync) Console.Out.WriteLine(json.Serialize(value)); }
  static void Error(string message) { Emit(new { ev = "error", message = message }); }
  static string S(Dictionary<string, object> m, string key) { return m.ContainsKey(key) && m[key] != null ? Convert.ToString(m[key]) : ""; }
  static double N(Dictionary<string, object> m, string key, double fallback) { double n; return double.TryParse(S(m,key), out n) ? n : fallback; }
  static Dictionary<string, object> D(Dictionary<string, object> m, string key) { return m.ContainsKey(key) && m[key] is Dictionary<string,object> ? (Dictionary<string,object>)m[key] : new Dictionary<string,object>(); }
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint pid);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public int Flags; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  static void Clamp() {
    IntPtr handle = new WindowInteropHelper(win).Handle;
    MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(info);
    RECT rect;
    if (!GetMonitorInfo(MonitorFromWindow(handle, 2), ref info) || !GetWindowRect(handle, out rect)) return;
    int x = Math.Max(info.Work.Left, Math.Min(rect.Left, info.Work.Right - (rect.Right - rect.Left)));
    int y = Math.Max(info.Work.Top, Math.Min(rect.Top, info.Work.Bottom - (rect.Bottom - rect.Top)));
    SetWindowPos(handle, IntPtr.Zero, x, y, 0, 0, 0x0015);
  }
  static bool FocusDesktop() {
    if ((DateTime.UtcNow-lastFocusRequest).TotalMilliseconds < 1000) return false;
    if (parentPid <= 0) throw new InvalidOperationException("Desktop process is unavailable");
    using (Process desktop = Process.GetProcessById(parentPid)) {
      if (desktop.HasExited) throw new InvalidOperationException("Desktop process has exited");
      var start = new ProcessStartInfo(desktop.MainModule.FileName, "dsh://open");
      start.UseShellExecute = false;
      start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
      start.EnvironmentVariables.Remove("NODE_OPTIONS");
      AllowSetForegroundWindow((uint)parentPid);
      using (Process request = Process.Start(start)) {
        if (request == null) throw new InvalidOperationException("Desktop restore request failed");
      }
    }
    lastFocusRequest = DateTime.UtcNow;
    return true;
  }
  static void Moved() {
    if (!active || !win.IsVisible) return;
    if (dragging && (DateTime.UtcNow-lastBoundsEvent).TotalMilliseconds < 250) return;
    lastBoundsEvent=DateTime.UtcNow;
    Emit(new { ev = "moved", x = (int)win.Left, y = (int)win.Top, width = (int)win.Width, height = (int)win.Height, avatarX=avatarX,avatarY=avatarY });
  }
  static void EndDrag() { if (!dragging) return; dragging = false; dragTimer.Stop(); if(lastBounds!=null) Bounds(lastBounds); else Clamp(); Moved(); }
  static void DragTick(object sender, EventArgs e) {
    if ((GetAsyncKeyState(1) & 0x8000) == 0 || !active) { EndDrag(); return; }
    POINT cursor; if (!GetCursorPos(out cursor)) return;
    var source = PresentationSource.FromVisual(win);
    if (source == null || source.CompositionTarget == null) return;
    Matrix matrix = source.CompositionTarget.TransformFromDevice;
    win.Left += (cursor.X - lastCursor.X) * matrix.M11;
    win.Top += (cursor.Y - lastCursor.Y) * matrix.M22;
    lastCursor = cursor;
  }
  // 主应用是否前台：前台窗口的进程等于 Desktop 父进程时，完成提示在前台静默。
  static void AppStateTick(object sender, EventArgs e) {
    uint pid = 0; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    bool next = parentPid > 0 && (int)pid == parentPid;
    if (!appStateKnown || next != appStateActive) { appStateKnown = true; appStateActive = next; Emit(new { ev = "app-state", active = next }); }
  }
  static void Bounds(Dictionary<string, object> m) {
    lastBounds = m;
    double size = N(m,"avatarSize",N(m,"width",144));
    double x = positioned ? win.Left + avatarX : SystemParameters.WorkArea.Right - size - 24;
    double y = positioned ? win.Top + avatarY : SystemParameters.WorkArea.Bottom - size * 208 / 192 - 24;
    var saved = D(m,"bounds");
    if (!positioned) {
      if(saved.ContainsKey("x")) x = N(saved,"x",x) + N(saved,"avatarX",0);
      if(saved.ContainsKey("y")) y = N(saved,"y",y) + N(saved,"avatarY",0);
    }
    var area = SystemParameters.WorkArea;
    var source = PresentationSource.FromVisual(win);
    var matrix = source == null || source.CompositionTarget == null ? Matrix.Identity : source.CompositionTarget.TransformFromDevice;
    MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(info);
    if(GetMonitorInfo(MonitorFromWindow(new WindowInteropHelper(win).Handle,2),ref info)) {
      area = new Rect(info.Work.Left * matrix.M11,info.Work.Top * matrix.M22,(info.Work.Right-info.Work.Left)*matrix.M11,(info.Work.Bottom-info.Work.Top)*matrix.M22);
    }
    avatarWidth = Math.Min(Math.Max(72,Math.Min(320,size)),area.Width);
    avatarHeight = Math.Min(Math.Ceiling(avatarWidth*208/192),area.Height);
    x = Math.Max(area.Left,Math.Min(x,area.Right-avatarWidth)); y = Math.Max(area.Top,Math.Min(y,area.Bottom-avatarHeight));
    double top = Math.Max(0,y-area.Top), bottom = Math.Max(0,area.Bottom-y-avatarHeight);
    bool above = top >= bottom, notice = S(m,"notification").ToLowerInvariant()=="true", caption = S(m,"caption").ToLowerInvariant()=="true";
    bool captionAbove = notice ? !above : above;
    double noticeLimit = Math.Max(0,Math.Min(276,N(m,"notificationHeight",notice?276:0)));
    noticeHeight = notice ? Math.Min(noticeLimit,Math.Max(0,(above?top:bottom)-4)) : 0;
    captionHeight = caption ? Math.Min(128,Math.Max(0,(captionAbove?top:bottom)-4)) : 0;
    bool stacked = notice && caption && captionHeight < 40 && Math.Max(top,bottom) >= 88;
    if(stacked) {
      double space = above ? top : bottom;
      captionHeight = Math.Min(128,Math.Max(40,Math.Floor((space-8)/3)));
      noticeHeight = Math.Min(noticeLimit,space-captionHeight-8);
    }
    double combinedHeight = noticeHeight + captionHeight + 4;
    double topHeight = stacked ? (above?combinedHeight:0) : (above?noticeHeight:0) + (captionAbove?captionHeight:0);
    double bottomHeight = stacked ? (above?0:combinedHeight) : (above?0:noticeHeight) + (captionAbove?0:captionHeight);
    double w = notice || caption ? Math.Min(!caption && noticeLimit<=48 ? Math.Max(avatarWidth,220) : 320,area.Width) : avatarWidth;
    win.Left = Math.Max(area.Left,Math.Min(x,area.Right-w)); win.Top = y - (topHeight>0?topHeight+4:0);
    win.Width = w; win.Height = avatarHeight + (topHeight>0?topHeight+4:0) + (bottomHeight>0?bottomHeight+4:0);
    avatarX = x-win.Left; avatarY = y-win.Top;
    noticeY = above ? 0 : avatarY + avatarHeight + 4; captionY = captionAbove ? 0 : avatarY + avatarHeight + 4;
    if(stacked) {
      captionY = above ? noticeHeight + 4 : avatarY + avatarHeight + 4;
      if(!above) noticeY = captionY + captionHeight + 4;
    }
    var layout = new Dictionary<string,object>();
    layout["bounds"] = new { x=win.Left,y=win.Top,width=win.Width,height=win.Height };
    layout["avatar"] = new { x=avatarX,y=avatarY,width=avatarWidth,height=avatarHeight };
    if(noticeHeight>0) layout["notification"] = new { x=0,y=noticeY,width=w,height=noticeHeight };
    if(captionHeight>0) layout["caption"] = new { x=0,y=captionY,width=w,height=captionHeight };
    positioned = true;
    Clamp();
    Emit(new { ev="layout",layout=layout });
  }
  static IntPtr HitTest(IntPtr hwnd,int message,IntPtr wParam,IntPtr lParam,ref bool handled) {
    if(message==0x0084 && !dragging) {
      int packed=lParam.ToInt32(); int x=(short)(packed&0xffff),y=(short)((packed>>16)&0xffff);
      var point=win.PointFromScreen(new Point(x,y));
      bool inside=(point.X>=avatarX&&point.X<avatarX+avatarWidth&&point.Y>=avatarY&&point.Y<avatarY+avatarHeight)
        || (noticeHeight>0&&point.X>=0&&point.X<win.Width&&point.Y>=noticeY&&point.Y<noticeY+noticeHeight)
        || (captionHeight>0&&point.X>=0&&point.X<win.Width&&point.Y>=captionY&&point.Y<captionY+captionHeight);
      if(!inside){handled=true;return new IntPtr(-1);}
    }
    if(message==0x02E0 && lastBounds!=null) win.Dispatcher.BeginInvoke(new Action(delegate { Bounds(lastBounds); }));
    return IntPtr.Zero;
  }
  static async void Show(Dictionary<string, object> m) {
    try {
      origin = new Uri(S(m,"url")).GetLeftPart(UriPartial.Authority); userData = S(m,"userData"); parentPid = (int)N(m,"parentPid",0);
      Bounds(m);
      if (!loaded) {
        string folder = userData;
        Directory.CreateDirectory(folder);
        await web.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null, folder));
        web.CoreWebView2.Settings.AreDevToolsEnabled = false;
        web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        web.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
          if (!e.IsSuccess) Error("navigation: " + e.WebErrorStatus);
        };
        web.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
          try { if (e.Source.StartsWith(origin + "/", StringComparison.Ordinal)) Bridge(json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson)); } catch (Exception ex) { Error("bridge: " + ex.Message); }
        };
        web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
          if (!e.Uri.StartsWith(origin + "/", StringComparison.Ordinal)) e.Cancel = true;
        };
        web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
        web.CoreWebView2.ProcessFailed += delegate { Error("webview process failed"); };
        web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        loaded = true;
      }
      web.DefaultBackgroundColor = System.Drawing.Color.Transparent;
      web.Source = new Uri(S(m,"url"));
      active = false;
    } catch (Exception ex) { Error("show: " + ex); }
  }
  static void Bridge(Dictionary<string, object> m) {
    string type = S(m,"type");
    if (type == "ready") { Emit(new { ev = "loaded" }); }
    else if (type == "error") { Error(S(m,"message")); }
    else if (type == "open") { if (FocusDesktop()) Emit(new { ev = "open" }); }
    else if (type == "notice-presented" || type == "notice-action") {
      var noticeEvent = new Dictionary<string,object> { {"ev",type},{"ownerId",S(m,"ownerId")},{"generation",N(m,"generation",-1)},{"sequence",N(m,"sequence",-1)},{"noticeId",S(m,"noticeId")},{"noticeGeneration",N(m,"noticeGeneration",-1)},{"action",S(m,"action")} };
      if(m.ContainsKey("noticeKind")) noticeEvent["noticeKind"] = m["noticeKind"];
      if(m.ContainsKey("connectionGeneration")) noticeEvent["connectionGeneration"] = m["connectionGeneration"];
      Emit(noticeEvent);
    }
    else if (type == "notice-page") {
      Emit(new { ev=type,ownerId=S(m,"ownerId"),generation=N(m,"generation",-1),sequence=N(m,"sequence",-1),cursor=m.ContainsKey("cursor") ? m["cursor"] : null });
    }
    else if (type == "notice-expansion") {
      Emit(new { ev=type,ownerId=S(m,"ownerId"),generation=N(m,"generation",-1),sequence=N(m,"sequence",-1),expanded=m.ContainsKey("expanded")?m["expanded"]:null });
    }
    else if (type == "drag-start") { if (GetCursorPos(out lastCursor)) { dragging = true; dragTimer.Start(); } }
    else if (type == "drag-end") { EndDrag(); }
  }
  static void Handle(string line) {
    Dictionary<string,object> m=json.Deserialize<Dictionary<string,object>>(line);
    string cmd=S(m,"cmd");
    if (cmd == "quit") { Application.Current.Shutdown(); return; }
    if (cmd == "hide") { EndDrag(); active = false; win.Hide(); return; }
    if (cmd == "notice-open") { FocusDesktop(); return; }
    if (cmd == "notice-result") {
      if(web.CoreWebView2!=null) web.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new CustomEvent('codingns-notice-result',{detail:"+json.Serialize(new { accepted=S(m,"accepted").ToLowerInvariant()=="true",message=S(m,"message") })+"}))");
      return;
    }
    if (cmd == "load") { Show(m); return; }
    if (cmd == "show") { if (!dragging) Bounds(m); active = true; if (!win.IsVisible) win.Show(); Emit(new { ev = "shown" }); return; }
    Error("unknown command " + cmd);
  }
  static void ReadStdin() {
    try { string line; while ((line=Console.ReadLine()) != null) { if (line.Length > 65536) break; string next=line; win.Dispatcher.BeginInvoke(new Action(delegate { try { Handle(next); } catch(Exception e) { Error("command: " + e.Message); } })); } }
    catch (Exception e) { Error("stdin: " + e.Message); }
    win.Dispatcher.BeginInvoke(new Action(delegate { Application.Current.Shutdown(); }));
  }
  [STAThread] public static void Run() {
    Application app=new Application(); app.ShutdownMode=ShutdownMode.OnExplicitShutdown;
    win=new Window(); win.WindowStyle=WindowStyle.None; win.ResizeMode=ResizeMode.NoResize;
    win.AllowsTransparency=true; win.Background=Brushes.Transparent; win.ShowInTaskbar=false;
    win.Topmost=true; win.ShowActivated=false; win.Width=144; win.Height=156; win.Opacity=1;
    web=new WebView2CompositionControl(); web.DefaultBackgroundColor=System.Drawing.Color.Transparent;
    dragTimer=new DispatcherTimer(); dragTimer.Interval=TimeSpan.FromMilliseconds(16); dragTimer.Tick += DragTick;
    appStateTimer=new DispatcherTimer(); appStateTimer.Interval=TimeSpan.FromSeconds(1.5); appStateTimer.Tick += AppStateTick; appStateTimer.Start();
    win.Content=web;
    win.SourceInitialized += delegate {
      IntPtr hwnd=new WindowInteropHelper(win).Handle;
      SetWindowLong(hwnd,-20,GetWindowLong(hwnd,-20) | 0x80);
      HwndSource.FromHwnd(hwnd).AddHook(HitTest);
    };
    Microsoft.Win32.SystemEvents.DisplaySettingsChanged += delegate { win.Dispatcher.BeginInvoke(new Action(delegate { if(lastBounds!=null) Bounds(lastBounds); else Clamp(); })); };
    win.Show(); win.Hide();
    Thread t=new Thread(ReadStdin); t.IsBackground=true; t.Start();

    app.Run();
  }
}
`.trim()

/** 路径作为 PowerShell 字面量引用，不拼成可执行命令。 */
function psQuote(value: string): string { return "'" + value.replace(/'/g, "''") + "'" }
export function buildWinAssistantScript(sdkRoot: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$root = ' + psQuote(sdkRoot),
    '$arch = if ([Environment]::Is64BitProcess) { if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" } } else { "x86" }',
    '$env:PATH = (Join-Path $root $arch) + ";" + $env:PATH',
    '$core = Join-Path $root "Microsoft.Web.WebView2.Core.dll"',
    '$wpf = Join-Path $root "Microsoft.Web.WebView2.Wpf.dll"',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Web.Extensions,System.Drawing',
    'Add-Type -Path $core,$wpf',
    "$cs = @'", CS, "'@",
    'Add-Type -TypeDefinition $cs -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Web.Extensions,System.Drawing,$core,$wpf',
    '[PetAgent]::Run()',
  ].join('\r\n')
}
