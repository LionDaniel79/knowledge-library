using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Xml;
using Forms=System.Windows.Forms;

partial class PdfDesktop {
    readonly TextBlock libraryStatus=new TextBlock{Text="서재를 확인합니다…",TextWrapping=TextWrapping.Wrap};
    readonly TextBlock backgroundStatus=new TextBlock{Text="백그라운드 준비 중",TextWrapping=TextWrapping.Wrap};
    readonly TextBlock connectionStatus=new TextBlock{Text="웹 연결 선택 사항 · 로컬 검색은 연결 없이 사용할 수 있습니다.",TextWrapping=TextWrapping.Wrap};
    readonly ProgressBar libraryProgress=new ProgressBar{Height=6,Minimum=0,Maximum=1};
    readonly ListBox libraryDocuments=new ListBox{Height=105};
    readonly Button pauseButton=new Button{Content="OCR 일시정지",Margin=new Thickness(3),Padding=new Thickness(9,4,9,4)};
    readonly CheckBox autoWeb=new CheckBox{Content="새 PDF 서지 자동 등록 (웹 연결 시)",Margin=new Thickness(3)};
    readonly DispatcherTimer backgroundTimer=new DispatcherTimer{Interval=TimeSpan.FromSeconds(2)};
    WorkerJob backgroundJob,monitorJob;
    Process backgroundProcess;
    Forms.NotifyIcon tray;
    FileSystemWatcher watcher;
    bool exiting,backgroundBusy,monitorBusy,paused,scanQueued=true,watcherFault,webSyncQueued,auditQueued;
    DateTime nextWebAttempt=DateTime.MinValue;
    DateTime scanAfter=DateTime.MinValue;
    Dictionary<string,object> latestLibrary;
    static string configFile="";
    static Dictionary<string,object> launchConfiguration;
    string webOrigin="",credentialFile="";
    Dictionary<string,object> PrepareRequest(){var req=Request("prepare-web");req["summary"]=true;return req;}

    static string[] LoadArguments(string[] args){
        if(args.Length==5)return args;
        if(args.Length==2 && args[0]=="--config"){
            configFile=Path.GetFullPath(args[1]);
            launchConfiguration=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(configFile,Encoding.UTF8));
            string[] names={"python","worker","index","root","directory"};
            return names.Select(n=>Val(launchConfiguration,n)).ToArray();
        }
        MessageBox.Show("Setup-PdfLibrary.ps1로 설치한 바로가기를 사용하세요. 기존 5개 인수 실행도 지원합니다.","PDF 서재");return null;
    }
    void BuildManagement(StackPanel bar){
        var tools=new WrapPanel();bar.Children.Add(tools);
        tools.Children.Add(Btn("전체 PDF 확인 / 추가 등록",QueueScan));
        tools.Children.Add(pauseButton);pauseButton.Click+=async(s,e)=>await SetPaused(!paused);
        tools.Children.Add(Btn("오류 다시 시도",RetryErrors));
        tools.Children.Add(Btn("위치 일괄 확인",AuditLocations));
        tools.Children.Add(Btn("웹 서지 일괄 등록",SyncWeb));
        tools.Children.Add(Btn("웹 연결 설정",ConfigureWeb));
        tools.Children.Add(Btn("종료",ExitApplication));
        bar.Children.Add(libraryStatus);bar.Children.Add(libraryProgress);bar.Children.Add(backgroundStatus);bar.Children.Add(connectionStatus);
        bar.Children.Add(autoWeb);
        autoWeb.Checked+=(s,e)=>SaveConnection();autoWeb.Unchecked+=(s,e)=>SaveConnection();
        bar.Children.Add(libraryDocuments);
        libraryDocuments.SelectionChanged+=(s,e)=>{
            var item=libraryDocuments.SelectedItem as ListBoxItem;if(item!=null)doc.Text=Val((Dictionary<string,object>)item.Tag,"id");
        };
        bar.Children.Add(new TextBlock{Text="창을 닫으면 알림 영역에서 계속 처리합니다. 종료하면 완료한 쪽까지 저장하고 다음 실행에서 이어갑니다.",TextWrapping=TextWrapping.Wrap});
    }
    void StartManagement(){
        Directory.CreateDirectory(data);
        if(launchConfiguration!=null){webOrigin=Val(launchConfiguration,"webOrigin");credentialFile=Val(launchConfiguration,"credentialFile");}
        var connection=Path.Combine(data,"web-connection.json");
        if(File.Exists(connection))try{var saved=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(connection,Encoding.UTF8));webOrigin=Val(saved,"webOrigin");credentialFile=Val(saved,"credentialFile");autoWeb.IsChecked=Val(saved,"autoSync")=="True";}catch{connectionStatus.Text="웹 연결 설정을 다시 확인하세요.";}
        if(credentialFile.Length==0)credentialFile=Path.Combine(data,"web-device.dpapi");
        RefreshConnection();
        tray=new Forms.NotifyIcon{Icon=System.Drawing.SystemIcons.Application,Text="전자도서관 PDF 서재",Visible=true};
        var menu=new Forms.ContextMenuStrip();
        menu.Items.Add("PDF 서재 열기",null,(s,e)=>Dispatcher.BeginInvoke(new Action(ShowFromTray)));
        menu.Items.Add("OCR 일시정지 / 계속",null,(s,e)=>Dispatcher.BeginInvoke(new Action(async()=>await SetPaused(!paused))));
        menu.Items.Add("종료",null,(s,e)=>Dispatcher.BeginInvoke(new Action(ExitApplication)));
        tray.ContextMenuStrip=menu;tray.DoubleClick+=(s,e)=>Dispatcher.BeginInvoke(new Action(ShowFromTray));
        Closing+=(s,e)=>{if(!exiting){e.Cancel=true;Hide();}else Cancel();};
        Closed+=(s,e)=>StopManagement();
        TryWatch();
        backgroundTimer.Tick+=async(s,e)=>{
            if(exiting)return;
            if(backgroundBusy){await RefreshLibrary();return;}
            await BackgroundCycle();
        };
        Loaded+=async(s,e)=>{await RefreshLibrary();backgroundTimer.Start();};
    }
    void ShowFromTray(){Show();WindowState=WindowState.Normal;Activate();}
    void QueueScan(){scanQueued=true;scanAfter=DateTime.UtcNow;backgroundStatus.Text="전체 PDF 확인 대기 중…";}
    void TryWatch(){
        if(watcher!=null || !Directory.Exists(root))return;
        try{
            watcher=new FileSystemWatcher(root){IncludeSubdirectories=true,NotifyFilter=NotifyFilters.FileName|NotifyFilters.DirectoryName|NotifyFilters.LastWrite,Filter="*"};
            FileSystemEventHandler changed=(s,e)=>Dispatcher.BeginInvoke(new Action(()=>{
                if(exiting)return;scanQueued=true;scanAfter=DateTime.UtcNow.AddSeconds(3);
            }));
            watcher.Created+=changed;watcher.Changed+=changed;watcher.Deleted+=changed;
            watcher.Renamed+=(s,e)=>changed(s,e);
            watcher.Error+=(s,e)=>Dispatcher.BeginInvoke(new Action(()=>{watcherFault=true;scanQueued=true;scanAfter=DateTime.UtcNow;backgroundStatus.Text="폴더 변경 감지가 중단되었습니다. 전체 PDF 확인을 실행하세요.";watcher.Dispose();watcher=null;}));
            watcher.EnableRaisingEvents=true;watcherFault=false;scanQueued=true;scanAfter=DateTime.UtcNow;
        }catch(IOException){watcherFault=true;if(watcher!=null)watcher.Dispose();watcher=null;}
        catch(UnauthorizedAccessException){watcherFault=true;if(watcher!=null)watcher.Dispose();watcher=null;}
    }
    async Task BackgroundCycle(){
        if(exiting||backgroundBusy)return;backgroundBusy=true;
        try{
            TryWatch();
            if(scanQueued && DateTime.UtcNow>=scanAfter){
                scanQueued=false;backgroundStatus.Text="전체 폴더 확인 중… 완료한 검사는 재사용합니다.";
                var req=Request("scan");req["root"]=root;AddIndex(req);
                var result=await RunWorker(req,86400,1);
                await RunWorker(PrepareRequest(),300,1);
                backgroundStatus.Text="PDF 확인 완료 · "+Val(result,"files")+"개 · 이번 내용 확인 "+Val(result,"hashed")+"개";
                await RefreshLibrary();
            }
            if(auditQueued && !exiting){auditQueued=false;await AuditLocationsNow();}
            bool pending=latestLibrary!=null && (Convert.ToInt32(latestLibrary["webPending"])>0 || Val(latestLibrary,"scanPending")=="True");
            if(!exiting && DateTime.UtcNow>=nextWebAttempt && (webSyncQueued || (autoWeb.IsChecked==true && pending)) && webOrigin.Length>0 && File.Exists(credentialFile)){
                webSyncQueued=false;nextWebAttempt=DateTime.UtcNow.AddMinutes(1);await SendWeb();
            }
            if(!exiting && !paused){
                var req=Request("ocr-step");AddIndex(req);var result=await RunWorker(req,180,1);
                var state=Val(result,"state");
                if(Val(result,"webMetadataChanged")=="True")await RunWorker(PrepareRequest(),300,1);
                if(state=="done"||state=="error")backgroundStatus.Text=Val(result,"title")+" · "+Val(result,"page")+"쪽 · "+(state=="done"?"색인 완료":"오류 · 다시 시도 가능");
                else if(state=="offline")backgroundStatus.Text="PDF 저장 장치를 연결하면 이어서 처리합니다.";
                await RefreshLibrary();
            }
        }catch(Exception ex){if(!exiting)backgroundStatus.Text=ex.Message;}
        finally{backgroundBusy=false;}
    }
    async Task RefreshLibrary(){
        if(monitorBusy||exiting)return;monitorBusy=true;
        try{
            var r=await RunWorker(Request("status"),20,2);if(exiting)return;latestLibrary=r;
            paused=(bool)r["paused"];pauseButton.Content=paused?"OCR 계속":"OCR 일시정지";
            var q=(Dictionary<string,object>)r["queue"];
            libraryStatus.Text="자료 "+Val(r,"resources")+"개 · 확인된 사본 "+Val(r,"availableCopies")+"개 · 전체 "+Val(r,"totalPages")+"쪽 / 완료 "+Val(r,"completedPages")+"쪽 · 대기 "+Val(q,"pending")+" · 처리 "+Val(q,"running")+" · 오류 "+Val(q,"error")+" · 웹 대기 "+Val(r,"webPending")+" / 보류 "+Val(r,"webHeld")+(paused?" · 일시정지":"")+(Val(r,"documentsTruncated")=="True"?" · 아래 목록은 첫 100개":"");
            libraryProgress.Maximum=Math.Max(1,Convert.ToDouble(r["totalPages"]));libraryProgress.Value=Convert.ToDouble(r["completedPages"]);
            string selected="";var old=libraryDocuments.SelectedItem as ListBoxItem;if(old!=null)selected=Val((Dictionary<string,object>)old.Tag,"id");
            libraryDocuments.Items.Clear();
            foreach(Dictionary<string,object> d in (IEnumerable)r["documents"]){
                var counts=(Dictionary<string,object>)d["queue"];
                var text=Val(d,"title")+" · "+Label(Val(d,"kind"))+" · "+Val(d,"totalPages")+"쪽 · 사본 "+Val(d,"copies")+" · 남은 쪽 "+(counts.ContainsKey("pending")?Val(counts,"pending"):"0")+" · 오류 "+(counts.ContainsKey("error")?Val(counts,"error"):"0");
                var errors=d["errors"] as IEnumerable;if(errors!=null)foreach(Dictionary<string,object> error in errors)text+="\n  "+Val(error,"page")+"쪽: "+Val(error,"error");
                if(Val(d,"error").Length>0)text+="\n  "+Val(d,"error");if(Val(d,"webIssue").Length>0)text+="\n  웹 등록 보류: "+Val(d,"webIssue");
                var item=new ListBoxItem{Content=text,Tag=d,ToolTip=Val(d,"id")};libraryDocuments.Items.Add(item);if(Val(d,"id")==selected)libraryDocuments.SelectedItem=item;
            }
            object scanning;if(r.TryGetValue("scan",out scanning)&&scanning!=null){var scan=(Dictionary<string,object>)scanning;if(Val(scan,"state")=="scanning")backgroundStatus.Text="폴더 확인 중 · "+Val(scan,"files")+"개 · 이번 내용 확인 "+Val(scan,"hashed")+"개";}
            object active;if(r.TryGetValue("current",out active)&&active!=null){var a=(Dictionary<string,object>)active;string title=Val(a,"title");if(title.Length==0)title=Val(a,"resource_id");backgroundStatus.Text=title+" · "+Val(a,"page_number")+"쪽 처리 중…";}
            if(paused && Val(r,"engineError").Length>0)backgroundStatus.Text=Val(r,"engineError");
            if(watcherFault)connectionStatus.Text="폴더 감지를 확인하세요. 전체 PDF 확인으로 변경분을 안전하게 찾을 수 있습니다.";
        }catch(Exception ex){if(!exiting)libraryStatus.Text=ex.Message;}finally{monitorBusy=false;}
    }
    async Task SetPaused(bool value){
        try{var req=Request("pause");req["paused"]=value;await RunDetached(req,20);paused=value;pauseButton.Content=value?"OCR 계속":"OCR 일시정지";backgroundStatus.Text=value?"현재 쪽을 마친 뒤 OCR을 일시정지합니다.":"남은 쪽부터 이어서 처리합니다.";await RefreshLibrary();}
        catch(Exception ex){backgroundStatus.Text=ex.Message;}
    }
    async void RetryErrors(){try{await RunDetached(Request("retry"),20);await RefreshLibrary();}catch(Exception ex){backgroundStatus.Text=ex.Message;}}
    void AuditLocations(){auditQueued=true;backgroundStatus.Text="현재 작업을 마친 뒤 전체 위치를 확인합니다.";}
    async Task AuditLocationsNow(){
        try{var report=await RunWorker(Request("audit"),86400,1);backgroundStatus.Text="위치 확인 완료 · 전체 "+Val(report,"physical")+" · 연결 "+Val(report,"available")+" · 웹 대상 사본 "+Val(report,"registrationCopies");
            var rows=((IEnumerable)report["locations"]).Cast<Dictionary<string,object>>().Select(d=>new{제목=Val(d,"title"),상태=Val(d,"state"),PC경로=Val(d,"localPath"),웹보관함=Val(d,"rootKey"),상대경로=Val(d,"relativePath"),마지막확인=Val(d,"lastCheckedAt")}).ToList();
            new Window{Owner=this,Title="PDF 위치 일괄 확인",Width=1050,Height=580,Content=new DataGrid{ItemsSource=rows,IsReadOnly=true,AutoGenerateColumns=true},WindowStartupLocation=WindowStartupLocation.CenterOwner}.Show();await RefreshLibrary();}
        catch(Exception ex){backgroundStatus.Text=ex.Message;}
    }
    async Task<Dictionary<string,object>> RunDetached(Dictionary<string,object> req,int seconds){
        // Small state transitions share the monitor lane and never cancel search/OCR.
        while(monitorBusy && !exiting)await Task.Delay(40);
        if(exiting)throw new OperationCanceledException();monitorBusy=true;
        try{return await RunWorker(req,seconds,2);}finally{monitorBusy=false;}
    }
    async Task<Dictionary<string,object>> RunWorker(Dictionary<string,object> req,int seconds,int lane){
        if(exiting)throw new OperationCanceledException();
        var info=new ProcessStartInfo(python,"-B \""+worker+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        info.EnvironmentVariables["PYTHONUTF8"]="1";
        using(var job=new WorkerJob())using(var p=new Process{StartInfo=info}){
            if(lane==0){currentJob=job;current=p;}else if(lane==1){backgroundJob=job;backgroundProcess=p;}else monitorJob=job;
            info.EnvironmentVariables["PDF_DESKTOP_JOB"]=job.Name;
            bool secret=Val(req,"action")=="library-sync-web";
            try{
                p.Start();var error=p.StandardError.ReadToEndAsync();
                var bytes=Encoding.UTF8.GetBytes(json.Serialize(req));try{p.StandardInput.BaseStream.Write(bytes,0,bytes.Length);}finally{Array.Clear(bytes,0,bytes.Length);p.StandardInput.Close();}
                var read=p.StandardOutput.ReadToEndAsync();
                if(await Task.WhenAny(read,Task.Delay(TimeSpan.FromSeconds(seconds)))!=read)throw new TimeoutException("작업 시간이 초과되었습니다. 완료한 쪽은 보존됩니다.");
                var result=json.Deserialize<Dictionary<string,object>>(await read);
                if(result==null||result.ContainsKey("error"))throw new Exception(secret?"웹 등록을 완료하지 못했습니다. 연결과 기기 인증을 확인하세요.":result==null?"응답이 없습니다.":Val(result,"error"));
                await error;return result;
            }finally{
                if(lane==0){if(currentJob==job)currentJob=null;if(current==p)current=null;}
                if(lane==1){if(backgroundJob==job)backgroundJob=null;if(backgroundProcess==p)backgroundProcess=null;}
                if(lane==2&&monitorJob==job)monitorJob=null;
            }
        }
    }
    internal void ExitApplication(){if(exiting)return;exiting=true;StopManagement();Cancel();Close();Application.Current.Shutdown();}
    void StopManagement(){
        backgroundTimer.Stop();if(watcher!=null){watcher.Dispose();watcher=null;}if(backgroundJob!=null){backgroundJob.Dispose();backgroundJob=null;}if(monitorJob!=null){monitorJob.Dispose();monitorJob=null;}if(tray!=null){tray.Visible=false;tray.Dispose();tray=null;}
    }
    static bool ValidOrigin(string value){Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.AbsolutePath=="/"&&uri.Query.Length==0&&uri.Fragment.Length==0&&uri.UserInfo.Length==0;}
    void RefreshConnection(){connectionStatus.Text=webOrigin.Length==0?"웹 연결 선택 사항 · 로컬 검색은 연결 없이 사용할 수 있습니다.":"웹 서지 연결: "+webOrigin+" · 도서 두 폴더의 서지·상대 위치만 전송";}
    void ConfigureWeb(){
        var window=new Window{Title="웹 서지 연결",Width=510,Height=285,Owner=this,WindowStartupLocation=WindowStartupLocation.CenterOwner,ResizeMode=ResizeMode.NoResize};
        var panel=new StackPanel{Margin=new Thickness(18)};window.Content=panel;
        panel.Children.Add(new TextBlock{Text="웹 주소 (HTTPS)",Margin=new Thickness(0,0,0,5)});var origin=new TextBox{Text=webOrigin};panel.Children.Add(origin);
        panel.Children.Add(new TextBlock{Text="웹에서 발급한 이 PC의 등록 권한 기기 키\n비워 두면 이 Windows 사용자에게 저장된 키를 재사용합니다.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,10,0,5)});
        var password=new PasswordBox();panel.Children.Add(password);
        var error=new TextBlock{TextWrapping=TextWrapping.Wrap};panel.Children.Add(error);
        panel.Children.Add(Btn("연결 저장",()=>{
            string value=origin.Text.Trim().TrimEnd('/');if(!ValidOrigin(value)){error.Text="HTTPS 주소만 입력하세요. 경로와 계정 정보는 포함하지 않습니다.";return;}
            try{
                var file=Path.Combine(data,"web-device.dpapi");
                if(password.Password.Length>0){if(!System.Text.RegularExpressions.Regex.IsMatch(password.Password,@"^klw_[A-Za-z0-9_-]{43}$")){error.Text="웹에서 발급한 기기 키를 확인하세요.";return;}File.WriteAllBytes(file,ProtectedData.Protect(Encoding.Unicode.GetBytes(password.Password),null,DataProtectionScope.CurrentUser));}
                else{
                    var reused=ExistingCredential(value);if(reused.Length>0)file=reused;
                    else if(value!=webOrigin || !File.Exists(credentialFile)){error.Text="이 주소에 저장된 기기 키가 없습니다. 웹에서 발급한 키를 입력하세요.";return;}
                    else file=credentialFile;
                }
                webOrigin=value;credentialFile=file;SaveConnection();password.Clear();RefreshConnection();window.DialogResult=true;
            }catch{error.Text="연결 설정을 이 Windows 사용자에게 저장하지 못했습니다.";}
        }));window.ShowDialog();
    }
    static string ExistingCredential(string origin){
        var hash=BitConverter.ToString(SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(origin)));
        foreach(var folder in new[]{"DeviceKeys","TestDeviceKeys"}){var file=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"KnowledgeLibrary",folder,hash+".xml");if(File.Exists(file))return file;}
        return "";
    }
    void SaveConnection(){
        var file=Path.Combine(data,"web-connection.json");File.WriteAllText(file,json.Serialize(new{webOrigin=webOrigin,credentialFile=credentialFile,autoSync=autoWeb.IsChecked==true}),Encoding.UTF8);
    }
    string ReadCredential(){
        byte[] bytes;
        if(credentialFile.EndsWith(".xml",StringComparison.OrdinalIgnoreCase)){
            var xml=new XmlDocument();xml.XmlResolver=null;xml.Load(credentialFile);var node=xml.SelectSingleNode("//*[local-name()='SS']");if(node==null)throw new Exception("저장된 기기 키를 확인하세요.");
            var hex=node.InnerText;bytes=new byte[hex.Length/2];for(int i=0;i<bytes.Length;i++)bytes[i]=Convert.ToByte(hex.Substring(i*2,2),16);
        }else bytes=File.ReadAllBytes(credentialFile);
        var plain=ProtectedData.Unprotect(bytes,null,DataProtectionScope.CurrentUser);
        try{return Encoding.Unicode.GetString(plain);}finally{Array.Clear(plain,0,plain.Length);}
    }
    void SyncWeb(){
        if(webOrigin.Length==0||!File.Exists(credentialFile)){ConfigureWeb();if(webOrigin.Length==0||!File.Exists(credentialFile))return;}
        webSyncQueued=true;nextWebAttempt=DateTime.UtcNow;backgroundStatus.Text="현재 쪽을 마친 뒤 웹 서지를 일괄 등록합니다.";
    }
    async Task SendWeb(){
        Dictionary<string,object> req=null;
        try{
            await RunWorker(PrepareRequest(),300,1);
            backgroundStatus.Text="선택 폴더의 서지 등록 전송 중…";
            req=Request("sync-web");req["origin"]=webOrigin;req["token"]=ReadCredential();
            var result=await RunWorker(req,86400,1);connectionStatus.Text="웹 등록 반영 "+Val(result,"applied")+" · 남은 요청 "+Val(result,"pending")+(Val(result,"scanPending")=="True"?" · 마지막 완료 검사 전송 대기":"")+(Val(result,"state")=="offline"?" · 연결 후 재시도하세요.":"");await RefreshLibrary();
        }catch{connectionStatus.Text="웹 등록을 완료하지 못했습니다. 연결과 기기 인증을 확인한 뒤 다시 시도하세요. 대기 목록은 보존됩니다.";}
        finally{if(req!=null)req.Remove("token");}
    }
}
