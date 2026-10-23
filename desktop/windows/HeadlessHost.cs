using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace KnowledgeLibrary
{
    public static class HeadlessHost
    {
        static string Absolute(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0)
                throw new InvalidOperationException();
            return Path.GetFullPath(value);
        }

        [STAThread]
        public static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            try
            {
                if ((args.Length != 2 && args.Length != 4) || args[0] != "--launcher" || (args.Length == 4 && args[2] != "--node")) return 2;
                string launcher = Absolute(args[1]);
                if (!String.Equals(launcher, Path.Combine(root, "start-private-pc.mjs"), StringComparison.OrdinalIgnoreCase) || !File.Exists(launcher)) return 2;
                string node;
                if (args.Length == 4) node = Absolute(args[3]);
                else
                {
                    var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "pc-runtime.json")));
                    node = Absolute(Convert.ToString(config["node"]));
                }
                if (!File.Exists(node)) return 2;
                string key;
                using (var digest = SHA256.Create())
                    key = BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
                using (var mutex = new Mutex(false, "Local\\KnowledgeLibraryServer-" + key))
                {
                    bool taken;
                    try { taken = mutex.WaitOne(0); } catch (AbandonedMutexException) { taken = true; }
                    if (!taken) return 0;
                    try
                    {
                        var info = new ProcessStartInfo(node, "\"" + launcher + "\"")
                        {
                            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                            WindowStyle = ProcessWindowStyle.Hidden,
                            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                        };
                        using (var output = new FileStream(Path.Combine(root, "launcher.out.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                        using (var errors = new FileStream(Path.Combine(root, "launcher.err.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                        using (var child = Process.Start(info))
                        {
                            child.StandardInput.Close();
                            Task stdout = child.StandardOutput.BaseStream.CopyToAsync(output);
                            Task stderr = child.StandardError.BaseStream.CopyToAsync(errors);
                            child.WaitForExit();
                            Task.WaitAll(stdout, stderr);
                            return child.ExitCode;
                        }
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
            catch (Exception)
            {
                try { File.AppendAllText(Path.Combine(root, "launcher.err.log"), DateTime.UtcNow.ToString("o") + " Library launcher failed. Check runtime paths and configuration." + Environment.NewLine); } catch (Exception) { }
                return 1;
            }
        }
    }
}
