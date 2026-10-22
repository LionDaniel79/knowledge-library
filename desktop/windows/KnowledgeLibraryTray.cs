using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KnowledgeLibrary
{
    public sealed class TrayConfig
    {
        public string TaskName, TaskExecutable, TaskArguments, RuntimeFile, AppRoot, DataFolder, Url, LogsFolder;
        public int Port = 3001;
        public static TrayConfig Load(string file)
        {
            var c = new JavaScriptSerializer().Deserialize<TrayConfig>(File.ReadAllText(file));
            Uri uri;
            if (c == null || String.IsNullOrWhiteSpace(c.TaskName) || c.TaskName.IndexOfAny(new[] { '\\', '/' }) >= 0 ||
                !Path.IsPathRooted(c.RuntimeFile) || !Path.IsPathRooted(c.AppRoot) || !Path.IsPathRooted(c.DataFolder) ||
                !Uri.TryCreate(c.Url, UriKind.Absolute, out uri) || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)) ||
                c.Port < 1 || c.Port > 65535 || String.IsNullOrEmpty(c.TaskExecutable) || String.IsNullOrEmpty(c.TaskArguments))
                throw new InvalidOperationException("트레이 설정을 확인해 주세요.");
            return c;
        }
    }
    public sealed class RuntimeState { public int pid, port; public string app, role, startedAt; }
    public sealed class ProcessIdentity { public int Pid; public string Executable, CommandLine; public DateTime StartedUtc; }
    public static class RuntimeGuard
    {
        internal static string Full(string path) { return Path.GetFullPath(path).TrimEnd('\\', '/').Replace('/', '\\'); }
        public static bool Matches(TrayConfig c, RuntimeState r, ProcessIdentity p)
        {
            try
            {
                if (r == null || p == null || String.IsNullOrWhiteSpace(p.CommandLine) || r.pid <= 0 || r.pid != p.Pid || r.port != c.Port || r.role != "library_web_runtime" ||
                    !String.Equals(Path.GetFileName(p.Executable), "node.exe", StringComparison.OrdinalIgnoreCase)) return false;
                if (!Full(r.app).StartsWith(Full(c.AppRoot) + "\\", StringComparison.OrdinalIgnoreCase)) return false;
                DateTime started;
                if (!DateTime.TryParse(r.startedAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out started) || Math.Abs((p.StartedUtc - started.ToUniversalTime()).TotalSeconds) > 30) return false;
                string[] a = Native.Arguments(p.CommandLine);
                return a.Length == 7 && String.Equals(Full(a[0]), Full(p.Executable), StringComparison.OrdinalIgnoreCase) &&
                    String.Equals(Full(a[1]), Full(Path.Combine(r.app, "node_modules/next/dist/bin/next")), StringComparison.OrdinalIgnoreCase) &&
                    a[2] == "start" && a[3] == "--hostname" && a[4] == "127.0.0.1" && a[5] == "--port" && a[6] == c.Port.ToString();
            }
            catch (Exception) { return false; }
        }
    }
    public sealed class ServerStatus { public bool Running, CanStop, DriveConnected; public string Label; public long MemoryMiB; }
    public interface IServerController
    {
        ServerStatus Status(); void Start(); void Stop(); void Restart(); void OpenLibrary(); void OpenLogs();
    }
    public sealed class ServerController : IServerController
    {
        readonly TrayConfig config;
        RuntimeState lastRuntime;
        public ServerController(TrayConfig config) { this.config = config; }
        RuntimeState Runtime()
        {
            try { lastRuntime = new JavaScriptSerializer().Deserialize<RuntimeState>(File.ReadAllText(config.RuntimeFile)); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            return lastRuntime;
        }
        static ProcessIdentity ProcessInfo(int pid)
        {
            if (pid <= 0) return null;
            using (var query = new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId=" + pid))
            using (var rows = query.Get())
                foreach (ManagementObject p in rows)
                    using (p) return new ProcessIdentity { Pid = Convert.ToInt32(p["ProcessId"]), Executable = p["ExecutablePath"] as string, CommandLine = p["CommandLine"] as string, StartedUtc = ManagementDateTimeConverter.ToDateTime((string)p["CreationDate"]).ToUniversalTime() };
            return null;
        }
        bool PortOpen()
        {
            using (var client = new TcpClient())
            {
                try
                {
                    var pending = client.BeginConnect("127.0.0.1", config.Port, null, null);
                    using (pending.AsyncWaitHandle) { if (!pending.AsyncWaitHandle.WaitOne(250)) return false; }
                    client.EndConnect(pending); return true;
                }
                catch (SocketException) { return false; }
            }
        }
        public ServerStatus Status()
        {
            bool drive = Directory.Exists(config.DataFolder);
            var r = Runtime(); var p = r == null ? null : ProcessInfo(r.pid);
            bool owned = RuntimeGuard.Matches(config, r, p);
            bool running = owned && PortOpen();
            long memory = 0;
            if (owned) { try { using (var process = Process.GetProcessById(r.pid)) memory = process.WorkingSet64 / (1024 * 1024); } catch (ArgumentException) { } }
            return new ServerStatus { Running = running, CanStop = owned, DriveConnected = drive, MemoryMiB = memory,
                Label = running ? (drive ? "서버 실행 중" : "실행 중 · 외장하드 연결 필요") : (drive ? "서버 중지됨" : "외장하드 연결 필요") };
        }
        void TaskAction(bool start, bool launch = true)
        {
            object service = null, folder = null, task = null, definition = null, actions = null, action = null, launched = null;
            try
            {
                service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); ((dynamic)service).Connect();
                folder = ((dynamic)service).GetFolder("\\"); task = ((dynamic)folder).GetTask(config.TaskName);
                definition = ((dynamic)task).Definition; actions = ((dynamic)definition).Actions;
                if ((int)((dynamic)actions).Count != 1) throw new InvalidOperationException("기존 서버 자동 실행 설정이 변경되었습니다.");
                action = ((dynamic)actions).Item(1);
                if (!String.Equals(RuntimeGuard.Full((string)((dynamic)action).Path), RuntimeGuard.Full(config.TaskExecutable), StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals((string)((dynamic)action).Arguments, config.TaskArguments, StringComparison.Ordinal))
                    throw new InvalidOperationException("기존 서버 자동 실행 설정을 확인해 주세요.");
                if (start) { ((dynamic)task).Enabled = true; if (launch) launched = ((dynamic)task).Run(null); }
                else
                {
                    // Suspend this task's watchdog as well, so its one-minute
                    // repeat trigger cannot undo a deliberate server stop.
                    ((dynamic)task).Enabled = false;
                    if ((int)((dynamic)task).State == 4 || (int)((dynamic)task).State == 2) ((dynamic)task).Stop(0);
                }
            }
            finally { foreach (var item in new[] { launched, action, actions, definition, task, folder, service }) if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item); }
        }
        public void Start()
        {
            if (Status().Running) { TaskAction(true, false); return; }
            if (!Directory.Exists(config.DataFolder)) throw new InvalidOperationException("외장하드를 연결한 뒤 서버를 시작해 주세요.");
            TaskAction(true);
            var end = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < end) { if (Status().Running) return; Thread.Sleep(500); }
            throw new InvalidOperationException("서버 준비가 지연됩니다. 잠시 후 상태를 확인해 주세요.");
        }
        public void Stop()
        {
            var r = Runtime(); var original = r == null ? null : ProcessInfo(r.pid);
            if (original != null && !RuntimeGuard.Matches(config, r, original)) throw new InvalidOperationException("서버 실행 정보를 확인할 수 없어 중지하지 않았습니다.");
            TaskAction(false);
            if (original != null)
            {
                var now = ProcessInfo(r.pid);
                if (now != null)
                {
                    if (now.StartedUtc != original.StartedUtc || !RuntimeGuard.Matches(config, r, now)) throw new InvalidOperationException("서버 실행 정보가 바뀌었습니다. 다시 확인해 주세요.");
                    try
                    {
                        using (var process = Process.GetProcessById(r.pid))
                        {
                            // Hold this exact process handle through the final
                            // creation-time check and kill; never reopen a reused PID.
                            var handle = process.Handle;
                            if (Math.Abs((process.StartTime.ToUniversalTime() - original.StartedUtc).TotalMilliseconds) > 2)
                                throw new InvalidOperationException("서버 프로세스가 바뀌어 중지하지 않았습니다.");
                            process.Kill(); process.WaitForExit(8000);
                        }
                    }
                    catch (ArgumentException) { }
                }
            }
            if (PortOpen()) throw new InvalidOperationException("PDF 연결 포트를 확인해 주세요. 다른 프로그램은 종료하지 않았습니다.");
        }
        public void Restart() { Stop(); Start(); }
        public void OpenLibrary() { Process.Start(new ProcessStartInfo(config.Url) { UseShellExecute = true }); }
        public void OpenLogs() { Process.Start(new ProcessStartInfo(config.LogsFolder) { UseShellExecute = true }); }
    }
    public sealed class TrayContext : ApplicationContext
    {
        readonly IServerController server;
        readonly NotifyIcon icon;
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly Dictionary<string, ToolStripMenuItem> items = new Dictionary<string, ToolStripMenuItem>();
        readonly Control dispatch = new Control();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Icon green = Native.BookIcon(Color.SeaGreen), gray = Native.BookIcon(Color.Gray), amber = Native.BookIcon(Color.DarkOrange);
        bool busy, polling, closed, quitPending;
        ServerStatus latest;
        public bool IconVisible { get { return !closed && icon.Visible; } }
        public ToolStripMenuItem MenuItem(string name) { return items[name]; }
        public TrayContext(IServerController server, bool autoStart)
        {
            this.server = server; var handle = dispatch.Handle;
            Add("상태 확인 중", null).Enabled = false;
            Add("서재 열기", delegate { server.OpenLibrary(); });
            menu.Items.Add(new ToolStripSeparator());
            Add("서버 시작", delegate { Run(server.Start); });
            Add("서버 다시 시작", delegate { Run(server.Restart); });
            Add("서버 중지", delegate { Run(server.Stop); });
            menu.Items.Add(new ToolStripSeparator());
            Add("로그 폴더 열기", delegate { server.OpenLogs(); });
            Add("트레이 아이콘 닫기", delegate { ExitThread(); });
            icon = new NotifyIcon { Icon = gray, Text = "지식서재 서버", ContextMenuStrip = menu, Visible = true };
            icon.DoubleClick += delegate { if (!busy) { if (latest != null && latest.Running) server.OpenLibrary(); else Run(delegate { server.Start(); server.OpenLibrary(); }); } };
            Render(server.Status());
            timer.Interval = 10000; timer.Tick += delegate { Poll(); }; timer.Start();
            if (autoStart && !latest.Running && latest.DriveConnected) Run(server.Start);
        }
        ToolStripMenuItem Add(string name, Action click)
        {
            var item = new ToolStripMenuItem(name); items.Add(name, item); menu.Items.Add(item);
            if (click != null) item.Click += delegate { try { click(); } catch (Exception) { Notice("요청을 처리하지 못했습니다. 서버 상태를 확인해 주세요."); } };
            return item;
        }
        void Post(Action action) { if (!closed && !dispatch.IsDisposed) { try { dispatch.BeginInvoke(action); } catch (InvalidOperationException) { } } }
        void Poll()
        {
            if (busy || polling || closed) return; polling = true;
            Task.Run(delegate { try { var status = server.Status(); Post(delegate { polling = false; Render(status); }); } catch (Exception) { Post(delegate { polling = false; items["상태 확인 중"].Text = "서버 상태 확인 필요"; }); } });
        }
        void Run(Action action)
        {
            if (busy || closed) return;
            busy = true; Enable();
            Task.Run(delegate
            {
                string error = null; ServerStatus status = null;
                try { action(); status = server.Status(); } catch (Exception e) { error = e is InvalidOperationException ? e.Message : "서버 제어에 실패했습니다. 로그 폴더를 확인해 주세요."; }
                Post(delegate { busy = false; if (status != null) Render(status); else Enable(); if (error != null) Notice(error); if (quitPending) ExitThread(); });
            });
        }
        void Render(ServerStatus status)
        {
            if (closed) return; latest = status;
            items["상태 확인 중"].Text = status.Label + (status.Running ? " · 메모리 " + status.MemoryMiB + "MB" : "");
            icon.Icon = !status.DriveConnected ? amber : status.Running ? green : gray;
            icon.Text = "지식서재 · " + status.Label; Enable();
        }
        void Enable()
        {
            items["서버 시작"].Enabled = !busy && latest != null && !latest.Running && latest.DriveConnected;
            items["서버 다시 시작"].Enabled = !busy && latest != null && latest.CanStop && latest.DriveConnected;
            items["서버 중지"].Enabled = !busy && latest != null && latest.CanStop;
            items["트레이 아이콘 닫기"].Enabled = !busy;
        }
        void Notice(string text) { if (!closed) icon.ShowBalloonTip(5000, "지식서재 서버", text, ToolTipIcon.Info); }
        public void RequestExit() { Post(delegate { quitPending = true; if (!busy) ExitThread(); }); }
        void Cleanup()
        {
            if (closed) return; closed = true; timer.Stop(); timer.Dispose(); icon.Visible = false; icon.Dispose(); menu.Dispose(); dispatch.Dispose(); green.Dispose(); gray.Dispose(); amber.Dispose();
        }
        protected override void ExitThreadCore() { Cleanup(); base.ExitThreadCore(); }
        protected override void Dispose(bool disposing) { if (disposing) Cleanup(); base.Dispose(disposing); }
    }
    internal static class Native
    {
        [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
        internal static string[] Arguments(string command)
        {
            int count; IntPtr ptr = CommandLineToArgvW(command, out count); if (ptr == IntPtr.Zero) return new string[0];
            try { var result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i * IntPtr.Size)); return result; }
            finally { LocalFree(ptr); }
        }
        internal static Icon BookIcon(Color color)
        {
            using (var bitmap = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bitmap))
            using (var brush = new SolidBrush(Color.FromArgb(36, 76, 65)))
            using (var dot = new SolidBrush(color))
            {
                g.Clear(Color.Transparent); g.FillRectangle(brush, 3, 4, 25, 25); g.DrawLine(Pens.White, 8, 6, 8, 26);
                g.DrawLine(Pens.White, 12, 11, 23, 11); g.DrawLine(Pens.White, 12, 16, 22, 16);
                g.FillEllipse(Brushes.White, 19, 19, 13, 13); g.FillEllipse(dot, 21, 21, 9, 9);
                IntPtr handle = bitmap.GetHicon(); try { using (var icon = Icon.FromHandle(handle)) return (Icon)icon.Clone(); } finally { DestroyIcon(handle); }
            }
        }
    }
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                string name = "Local\\KnowledgeLibraryTray-" + WindowsIdentity.GetCurrent().User.Value;
                if (args.Length == 1 && args[0] == "--quit") { try { using (var e = EventWaitHandle.OpenExisting(name + "-Quit")) e.Set(); } catch (WaitHandleCannotBeOpenedException) { } return 0; }
                if (args.Length == 2 && args[0] == "--write-icon") { using (var icon = Native.BookIcon(Color.SeaGreen)) using (var file = File.Create(args[1])) icon.Save(file); return 0; }
                var server = new ServerController(TrayConfig.Load(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tray-config.json")));
                if (args.Length > 0)
                {
                    // A windowless executable has no console code page to set.
                    // Write UTF-8 to redirected pipes without SetConsoleOutputCP.
                    Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
                    Console.SetError(new StreamWriter(Console.OpenStandardError(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
                    if (args.Length != 2 || args[0] != "--command") return 2;
                    if (args[1] == "start") server.Start(); else if (args[1] == "stop") server.Stop(); else if (args[1] == "restart") server.Restart(); else if (args[1] != "status") return 2;
                    Console.WriteLine(new JavaScriptSerializer().Serialize(server.Status())); return 0;
                }
                bool first;
                using (var mutex = new Mutex(true, name, out first))
                {
                    if (!first) return 0;
                    try
                    {
                        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                        using (var context = new TrayContext(server, true))
                        using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-Quit"))
                        {
                            var wait = ThreadPool.RegisterWaitForSingleObject(quit, delegate { context.RequestExit(); }, null, -1, false);
                            try { Application.Run(context); } finally { wait.Unregister(null); }
                        }
                    }
                    finally { mutex.ReleaseMutex(); }
                }
                return 0;
            }
            catch (Exception) { if (args.Length == 0) MessageBox.Show("지식서재 서버 트레이 설정을 확인해 주세요.", "지식서재", MessageBoxButtons.OK, MessageBoxIcon.Information); else Console.Error.WriteLine("지식서재 서버 설정·실행 상태를 확인해 주세요."); return 1; }
        }
    }
}
