using System;
using System.IO;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Threading.Tasks;

partial class PdfDesktop {
    internal int[] CatalogSmokePids=new int[0];
    static string SmokeVisibleText(DependencyObject root){
        var text=root as System.Windows.Controls.TextBlock;var result=text==null?"":text.Text;
        foreach(var child in LogicalTreeHelper.GetChildren(root)){var node=child as DependencyObject;if(node!=null)result+="\n"+SmokeVisibleText(node);}
        return result;
    }
    async Task CheckCatalogSmoke(){
        var mode=launchConfiguration==null?"":Val(launchConfiguration,"catalogSmokeProbe");
        if(mode.Length==0)return;
        var file=Path.Combine(data,"catalog-sidecar-probe.json");
        if(mode=="invalid"){
            await Task.Delay(250);
            if(File.Exists(file))throw new Exception("Invalid optional collector configuration started a process.");
            var text=SmokeVisibleText(this);
            if(!text.Contains("서지 보완") || !text.Contains("설정"))throw new Exception("Invalid collector configuration must show a safe status message.");
            if(text.Contains("secret-sentinel") || text.Contains("missing-node.exe"))throw new Exception("Collector configuration details leaked to the UI.");
            return;
        }
        for(int i=0;i<100 && !File.Exists(file);i++)await Task.Delay(50);
        if(!File.Exists(file))throw new Exception("Optional collector did not start with the native app.");
        var probe=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
        CatalogSmokePids=new[]{Convert.ToInt32(probe["parent"]),Convert.ToInt32(probe["child"])};
        if((bool)probe["unsafeEnvironment"] || !(bool)probe["validArguments"])throw new Exception("Collector host inherited secrets or received incorrect arguments.");
        foreach(int pid in CatalogSmokePids)using(var process=System.Diagnostics.Process.GetProcessById(pid))if(process.HasExited)throw new Exception("Collector process exited before native shutdown.");
    }
    public async Task Inspect(string screenshot){
        if(!Title.Contains("PDF 서재"))throw new Exception("Standalone management UI is missing.");
        if(File.Exists(credentialFile) && ReadCredential()!="klw_"+new string('a',43))throw new Exception("Synthetic DPAPI key could not be read by desktop app.");
        backgroundTimer.Stop();await SetPaused(true);
        await CheckCatalogSmoke();
        var catalogNotice=Path.Combine(data,"catalog-request.json");
        NotifyCatalog(0);
        if(File.Exists(catalogNotice))throw new Exception("No-op web sync must not wake the collector.");
        NotifyCatalog(1);
        var notice=File.ReadAllText(catalogNotice);
        var fields=json.Deserialize<Dictionary<string,object>>(notice);Guid requestId;
        if(fields.Count!=2 || !fields.ContainsKey("requestedAt") || !Guid.TryParse(Val(fields,"requestId"),out requestId))throw new Exception("Collector notice must contain only opaque ID and timestamp.");
        NotifyCatalog(0);
        if(File.ReadAllText(catalogNotice)!=notice)throw new Exception("No-op rewrote the collector notice.");
        NotifyCatalog(2);
        if(File.ReadAllText(catalogNotice)==notice || Directory.GetFiles(data,".catalog-*.tmp").Length!=0)throw new Exception("Collector notice was not atomically replaced.");
        var req=Request("scan");req["root"]=root;AddIndex(req);
        var scanning=RunWorker(req,40,1);Cancel();
        var registered=await scanning;
        if(Convert.ToInt32(registered["files"])<1)throw new Exception("Search cancellation killed the background import.");
        await RefreshLibrary();
        if(latestLibrary==null || Convert.ToInt32(latestLibrary["resources"])<1 || libraryDocuments.Items.Count<1)throw new Exception("PDF inventory/progress missing.");
        if(index.Length==0){
            await SetPaused(false);var step=Request("ocr-step");await RunWorker(step,40,1);await RefreshLibrary();
            if(Convert.ToInt32(((Dictionary<string,object>)latestLibrary["queue"])["done"])<1)throw new Exception("No-index durable OCR page did not complete.");
        }
        query.Text=index.Length==0?"Library":"영적인 사람";Search();
        for(int i=0;i<120 && current!=null;i++)await Task.Delay(100);
        if(results.Items.Count<1)throw new Exception("WPF search: "+status.Text);
        results.SelectedIndex=0;Render();
        for(int i=0;i<160 && current!=null;i++)await Task.Delay(100);
        if(image.Source==null)throw new Exception("WPF render: "+status.Text);
        await AuditLocationsNow();
        if(OwnedWindows.Count!=1 || ((System.Windows.Controls.DataGrid)OwnedWindows[0].Content).Items.Count<1)throw new Exception("Location report rows are missing.");
        OwnedWindows[0].Close();
        UpdateLayout();
        var bmp=new RenderTargetBitmap((int)ActualWidth,(int)ActualHeight,96,96,PixelFormats.Pbgra32);
        bmp.Render(this);var enc=new PngBitmapEncoder();enc.Frames.Add(BitmapFrame.Create(bmp));
        using(var f=new FileStream(screenshot,FileMode.CreateNew))enc.Save(f);
        Search();Cancel();await Task.Delay(300);
        if(current!=null && !current.HasExited)throw new Exception("Worker cancellation failed.");
        await CheckCatalogSmoke();
        scanQueued=false;
        var first=Directory.GetFiles(root,"*.pdf",SearchOption.AllDirectories)[0];
        var added=Path.Combine(root,"UI smoke new copy.pdf");File.Copy(first,added);
        await Task.Delay(600);if(!scanQueued)throw new Exception("New PDF watcher did not queue a scan.");
        await SetPaused(true);backgroundTimer.Start();Close();
        if(IsVisible || exiting || tray==null || !backgroundTimer.IsEnabled)throw new Exception("Closing must keep background tray lifetime.");
        await CheckCatalogSmoke();
        ShowFromTray();backgroundTimer.Stop();
        Console.WriteLine("PASS WPF "+(index.Length==0?"no-index OCR":"legacy overlay")+" search/render/cancel/import/queue/watcher/tray");
    }
    internal int StartExitProbe(){
        var req=Request("scan");req["root"]=root;AddIndex(req);
        RunWorker(req,40,1).ContinueWith(t=>{var ignored=t.Exception;});
        return backgroundProcess.Id;
    }
}
class DesktopSmoke {
    [STAThread] static int Main(string[] args){
        string screenshot=args[args.Length-1];
        if(args[0]=="--config")args=PdfDesktop.SmokeArguments(args);
        var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};var window=new PdfDesktop(args);
        window.ShowInTaskbar=false;window.WindowStartupLocation=WindowStartupLocation.Manual;window.Left=-12000;window.Top=0;
        int result=0,exitPid=0;
        window.ContentRendered+=async(s,e)=>{try{await window.Inspect(screenshot);exitPid=window.StartExitProbe();}
            catch(Exception ex){Console.Error.WriteLine(ex);result=1;}finally{window.ExitApplication();}};
        app.Run(window);
        if(exitPid>0)try{using(var child=System.Diagnostics.Process.GetProcessById(exitPid)){if(!child.WaitForExit(2500)){Console.Error.WriteLine("Explicit Exit left a background worker alive.");result=1;}}}catch(ArgumentException){}
        if(result==0)Console.WriteLine("PASS explicit Exit stopped worker process");
        foreach(int pid in window.CatalogSmokePids)try{using(var process=System.Diagnostics.Process.GetProcessById(pid)){
            if(!process.WaitForExit(2500)){Console.Error.WriteLine("Explicit Exit left an optional collector process alive.");result=1;process.Kill();process.WaitForExit(2500);}
        }}catch(ArgumentException){}
        if(result==0 && window.CatalogSmokePids.Length>0)Console.WriteLine("PASS optional collector minimal environment/search cancel/tray lifetime/Exit process tree");
        return result;
    }
}

partial class PdfDesktop {
    internal static string[] SmokeArguments(string[] args){return LoadArguments(new[]{args[0],args[1]});}
}
