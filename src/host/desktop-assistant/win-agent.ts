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
  static bool loaded = false;
  static bool active = false;
  static bool dragging = false;
  static DispatcherTimer dragTimer;
  static POINT lastCursor;
  static DateTime lastBoundsEvent = DateTime.MinValue;
  static DateTime lastFocusRequest = DateTime.MinValue;
  static object sync = new object();
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
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
    Emit(new { ev = "moved", x = (int)win.Left, y = (int)win.Top, width = (int)win.Width, height = (int)win.Height });
  }
  static void EndDrag() { if (!dragging) return; dragging = false; dragTimer.Stop(); Clamp(); Moved(); }
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
  static void Bounds(Dictionary<string, object> m) {
    double w = Math.Max(72, Math.Min(320, N(m,"width",144)));
    win.Width = w; win.Height = Math.Max(78, Math.Min(480, N(m,"height",156)));
    var saved = D(m,"bounds");
    if (!positioned) {
      win.Left = saved.ContainsKey("x") ? N(saved,"x",0) : SystemParameters.WorkArea.Right - w - 24;
      win.Top = saved.ContainsKey("y") ? N(saved,"y",0) : SystemParameters.WorkArea.Bottom - win.Height - 24;
      positioned = true;
    }
    Clamp();
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
    else if (type == "drag-start") { if (GetCursorPos(out lastCursor)) { dragging = true; dragTimer.Start(); } }
    else if (type == "drag-end") { EndDrag(); }
  }
  static void Handle(string line) {
    Dictionary<string,object> m=json.Deserialize<Dictionary<string,object>>(line);
    string cmd=S(m,"cmd");
    if (cmd == "quit") { Application.Current.Shutdown(); return; }
    if (cmd == "hide") { EndDrag(); active = false; win.Hide(); return; }
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
    win.Content=web;
    win.SourceInitialized += delegate {
      IntPtr hwnd=new WindowInteropHelper(win).Handle;
      SetWindowLong(hwnd,-20,GetWindowLong(hwnd,-20) | 0x80);
    };
    Microsoft.Win32.SystemEvents.DisplaySettingsChanged += delegate { win.Dispatcher.BeginInvoke(new Action(Clamp)); };
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
