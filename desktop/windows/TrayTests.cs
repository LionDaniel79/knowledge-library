using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using KnowledgeLibrary;

public static class TrayTests
{
    static int passed;
    static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); passed++; }
    [STAThread]
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "library-tray-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var config = new TrayConfig { AppRoot = root, Port = 3001, Url = "https://example.invalid/" };
            var runtime = new RuntimeState { pid = 7, app = Path.Combine(root, "release"), port = 3001, role = "library_web_runtime", startedAt = "2026-10-23T00:00:00Z" };
            var snapshot = new ProcessIdentity { Pid = 7, Executable = @"C:\Program Files\nodejs\node.exe", StartedUtc = DateTime.Parse(runtime.startedAt).ToUniversalTime() };
            snapshot.CommandLine = "\"C:\\Program Files\\nodejs\\node.exe\" \"" + runtime.app + "/node_modules/next/dist/bin/next\" start --hostname 127.0.0.1 --port 3001";
            Check(RuntimeGuard.Matches(config, runtime, snapshot), "owned Node should match");
            snapshot.Pid = 8; Check(!RuntimeGuard.Matches(config, runtime, snapshot), "PID reuse must not match"); snapshot.Pid = 7;
            snapshot.StartedUtc = snapshot.StartedUtc.AddHours(1); Check(!RuntimeGuard.Matches(config, runtime, snapshot), "different start time must not match"); snapshot.StartedUtc = snapshot.StartedUtc.AddHours(-1);
            string command = snapshot.CommandLine;
            snapshot.CommandLine = command.Replace("--port 3001", "--port 30010"); Check(!RuntimeGuard.Matches(config, runtime, snapshot), "port substring must not match");
            snapshot.CommandLine = command.Replace("127.0.0.1", "0.0.0.0"); Check(!RuntimeGuard.Matches(config, runtime, snapshot), "different host must not match");
            snapshot.CommandLine = command.Replace("/node_modules/next/dist/bin/next", "/other.js"); Check(!RuntimeGuard.Matches(config, runtime, snapshot), "unrelated Node must not match"); snapshot.CommandLine = command;
            config.AppRoot = Path.Combine(root, "another"); Check(!RuntimeGuard.Matches(config, runtime, snapshot), "outside deployment root must not match"); config.AppRoot = root;
            runtime.role = "another"; Check(!RuntimeGuard.Matches(config, runtime, snapshot), "wrong role must not match"); runtime.role = "library_web_runtime";
            Check(!RuntimeGuard.Matches(config, null, snapshot), "missing runtime must be safe");

            var fake = new FakeServer();
            using (var context = new TrayContext(fake, false))
            {
                Check(context.IconVisible, "tray icon visible");
                Check(context.MenuItem("서버 시작").Enabled, "start enabled while stopped");
                Check(!context.MenuItem("서버 중지").Enabled, "stop disabled while stopped");
                context.MenuItem("서버 시작").PerformClick(); Pump(() => fake.Starts == 1 && context.MenuItem("서버 중지").Enabled);
                context.MenuItem("서버 다시 시작").PerformClick(); Pump(() => fake.Restarts == 1 && context.MenuItem("서버 중지").Enabled);
                context.MenuItem("서재 열기").PerformClick(); Check(fake.Opened == 1, "open action should use controller");
                context.MenuItem("서버 중지").PerformClick(); Pump(() => fake.Stops == 1 && context.MenuItem("서버 시작").Enabled);
                context.MenuItem("트레이 아이콘 닫기").PerformClick(); Application.DoEvents();
                Check(fake.Stops == 1, "closing tray must not stop server a second time");
                Check(!context.IconVisible, "icon removed on close");
            }
            Console.WriteLine("PASS " + passed + " native assertions, including actual tray menu events");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { Directory.Delete(root); }
    }
    static void Pump(Func<bool> done)
    {
        var end = DateTime.UtcNow.AddSeconds(5);
        while (!done() && DateTime.UtcNow < end) { Application.DoEvents(); Thread.Sleep(20); }
        Check(done(), "tray action timed out");
    }
    sealed class FakeServer : IServerController
    {
        public int Starts, Stops, Restarts, Opened;
        bool running;
        public ServerStatus Status() { return new ServerStatus { Running = running, CanStop = running, DriveConnected = true, Label = running ? "실행 중" : "중지됨" }; }
        public void Start() { Starts++; running = true; }
        public void Stop() { Stops++; running = false; }
        public void Restart() { Restarts++; running = true; }
        public void OpenLibrary() { Opened++; }
        public void OpenLogs() { }
    }
}
