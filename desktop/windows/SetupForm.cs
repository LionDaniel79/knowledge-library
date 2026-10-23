using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KnowledgeLibrary.Setup {
 public sealed class SetupForm:Form {
  readonly TextBox install=Input(),data=Input(),pdf=Input(),origin=Input(),connection=Input(),password=Input(true),source=Input(),envFile=Input(),exportPassword=Input(true);
  readonly TextBox log=new TextBox {Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,BackColor=Color.White};
  readonly Button run=new Button {Text="이 PC에 설치",AutoSize=true};
  readonly ProgressBar progress=new ProgressBar {Dock=DockStyle.Bottom,Height=12,Style=ProgressBarStyle.Marquee,Visible=false};
  readonly Label status=new Label {Text="연결 파일과 설치 위치를 선택해 주세요.",AutoSize=true,Padding=new Padding(8)};
  bool busy;
  public SetupForm() {
   Text="지식서재 · PC 추가 설치";Font=new Font("Segoe UI",10);StartPosition=FormStartPosition.CenterScreen;Size=new Size(880,780);MinimumSize=new Size(720,650);AutoScaleMode=AutoScaleMode.Dpi;
   var tabs=new TabControl {Dock=DockStyle.Fill};var setup=new TabPage("새 PC 설치");var export=new TabPage("기존 PC에서 연결 파일 만들기");tabs.TabPages.AddRange(new[]{setup,export});Controls.Add(tabs);Controls.Add(progress);
   var layout=BuildLayout();setup.Controls.Add(layout);
   AddText(layout,"기존 온라인 서재를 이 PC에서 사용하도록 준비합니다. 큰 자료와 임시 파일은 자료 저장 폴더에 둡니다.");
   install.Text=Directory.Exists(@"D:\")&&new DriveInfo(@"D:\").DriveFormat=="NTFS"?@"D:\KnowledgeLibrary":Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","KnowledgeLibrary");
   data.Text=Directory.Exists(@"E:\")?@"E:\지식서재 작업":Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"KnowledgeLibraryData");
   pdf.Text=Directory.Exists(@"E:\전자도서관")?@"E:\전자도서관":Path.Combine(data.Text,"PDF");
   AddFolder(layout,"프로그램 설치 폴더",install);AddFolder(layout,"색인·캐시 자료 폴더",data);AddFolder(layout,"PDF 원본 폴더",pdf);
   AddFile(layout,"암호화 연결 파일",connection,"지식서재 연결 파일|*.klconnection|모든 파일|*.*");AddRow(layout,"연결 파일 암호",password,null);
   var find=Button("PC 주소 찾기",async()=>await FindPcOrigin());AddRow(layout,"이 PC의 비공개 주소",origin,find);
   var actions=new FlowLayoutPanel {AutoSize=true,Dock=DockStyle.Fill};
   actions.Controls.Add(Button("Tailscale 로그인 안내",()=>Open("https://tailscale.com/download/windows")));
   actions.Controls.Add(Button("비공개 PDF 연결 설정",()=>ConfigureServe()));
   actions.Controls.Add(Button("한국어·영어 OCR 설치",()=>InstallOcr()));
   actions.Controls.Add(Button("폴더 연결 마무리",()=>{if(!SetupPaths.IsPrivateOrigin(origin.Text.Trim()))throw new InvalidOperationException();Open(origin.Text.Trim().TrimEnd('/')+"/?view=pdf&panel=folder");}));
   layout.Controls.Add(actions);layout.SetColumnSpan(actions,3);
   AddText(layout,"처음 한 번: Tailscale 본인 로그인 · 새 주소의 Google 로그인 허용 등록이 필요할 수 있습니다.");
   run.Click+=async delegate {await Install();};layout.Controls.Add(run);layout.SetColumnSpan(run,3);
   layout.Controls.Add(status);layout.SetColumnSpan(status,3);layout.Controls.Add(log);layout.SetColumnSpan(log,3);
   for(int i=0;i<=layout.GetRow(log);i++)layout.RowStyles.Add(new RowStyle(i==layout.GetRow(log)?SizeType.Percent:SizeType.AutoSize,i==layout.GetRow(log)?100:0));
   var ex=BuildLayout();export.Controls.Add(ex);
   AddText(ex,"현재 사용 중인 PC에서 연결 파일을 만드세요. 파일과 암호를 새 PC로 옮긴 뒤 ‘새 PC 설치’에서 불러옵니다.");
   AddFile(ex,"기존 보호 설정",source,"보호 설정|*.json|모든 파일|*.*");
   AddFile(ex,"추가 설정 파일(.env, 선택)",envFile,"환경 설정|.env*|모든 파일|*.*");
   AddRow(ex,"새 연결 파일 암호(12자 이상)",exportPassword,null);
   var exportButton=Button("암호화 연결 파일 저장",()=>Export());ex.Controls.Add(exportButton);ex.SetColumnSpan(exportButton,3);
   AddText(ex,"연결 파일에는 제한 권한 DB·로그인·도서정보 API 설정만 담습니다. PDF·메모·GPT 키는 담지 않습니다.");
   AddText(ex,"새로 설치한 PC의 설정은 프로그램 폴더의 connection.dpapi.json을 선택하면 됩니다.");
   DiscoverExistingSource();
   FormClosing+=delegate(object sender,FormClosingEventArgs e){if(busy){e.Cancel=true;MessageBox.Show(this,"설치가 진행 중입니다. 현재 단계가 끝난 뒤 닫아 주세요.","지식서재");}};
  }
  public void SelectExport() {Controls.OfType<TabControl>().First().SelectedIndex=1;}
  static TextBox Input(bool secret=false) {return new TextBox {Dock=DockStyle.Fill,UseSystemPasswordChar=secret,Margin=new Padding(3,5,3,5)};}
  static TableLayoutPanel BuildLayout() {var t=new TableLayoutPanel {Dock=DockStyle.Fill,AutoScroll=true,ColumnCount=3,Padding=new Padding(16)};t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,195));t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,130));return t;}
  static void AddText(TableLayoutPanel t,string text) {var l=new Label {Text=text,AutoSize=true,MaximumSize=new Size(760,0),Margin=new Padding(0,7,0,12)};t.Controls.Add(l);t.SetColumnSpan(l,3);}
  static void AddRow(TableLayoutPanel t,string name,Control input,Control action) {t.Controls.Add(new Label {Text=name,AutoSize=true,MaximumSize=new Size(185,0),Anchor=AnchorStyles.Left});t.Controls.Add(input);t.Controls.Add(action??new Label());}
  static Button Button(string name,Action action) {var b=new Button {Text=name,AutoSize=true,Margin=new Padding(3,4,3,4)};b.Click+=delegate {try{action();}catch(Exception){MessageBox.Show("요청을 처리하지 못했습니다. 선택한 파일과 설정을 확인해 주세요.","지식서재");}};return b;}
  void AddFolder(TableLayoutPanel t,string name,TextBox input) {AddRow(t,name,input,Button("폴더 선택",()=>{using(var d=new FolderBrowserDialog {SelectedPath=input.Text})if(d.ShowDialog(this)==DialogResult.OK)input.Text=d.SelectedPath;}));}
  void AddFile(TableLayoutPanel t,string name,TextBox input,string filter) {AddRow(t,name,input,Button("파일 선택",()=>{using(var d=new OpenFileDialog {Filter=filter})if(d.ShowDialog(this)==DialogResult.OK)input.Text=d.FileName;}));}
  void Append(string text) {if(IsDisposed)return;if(InvokeRequired){BeginInvoke(new Action<string>(Append),text);return;}log.AppendText(text+Environment.NewLine);status.Text=text.StartsWith("STEP|")?text.Substring(5):text.StartsWith("DONE|")?text.Substring(5):status.Text;}
  static void Open(string url) {Process.Start(new ProcessStartInfo(url) {UseShellExecute=true});}
  void DiscoverExistingSource() {
   var current=Path.Combine(install.Text,"connection.dpapi.json");var legacy=Path.Combine(data.Text,"private-data","config","web-runtime.private.json");
   source.Text=File.Exists(current)?current:File.Exists(legacy)?legacy:"";
   var ops=Path.Combine(data.Text,"private-data","operations");
   if(!Directory.Exists(ops))return;
   foreach(var dir in Directory.GetDirectories(ops)) {
    var launcher=Path.Combine(dir,"start-private-pc.mjs");if(!File.Exists(launcher))continue;
    var match=Regex.Match(File.ReadAllText(launcher),@"\bsource\s*=\s*['""]([^'""]+)['""]");
    if(match.Success&&File.Exists(Path.Combine(match.Groups[1].Value,".env.local"))){envFile.Text=Path.Combine(match.Groups[1].Value,".env.local");break;}
   }
  }
  void Export() {
   try {
    var profile=Profile.ReadSources(source.Text.Trim(),envFile.Text.Trim());
    var bytes=ConnectionVault.Encrypt(profile,exportPassword.Text);
    using(var save=new SaveFileDialog {Filter="지식서재 연결 파일|*.klconnection",FileName="지식서재-PC연결.klconnection",OverwritePrompt=true})
     if(save.ShowDialog(this)==DialogResult.OK){File.WriteAllBytes(save.FileName,bytes);exportPassword.Clear();MessageBox.Show(this,"암호화 연결 파일을 저장했습니다. 새 PC로 파일을 옮겨 불러오세요.","지식서재");}
   }catch(Exception){MessageBox.Show(this,"연결 파일을 만들지 못했습니다. 기존 보호 설정·추가 설정 파일과 12자 이상 암호를 확인해 주세요.","지식서재");}
  }
  static string Tailscale() {var path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Tailscale","tailscale.exe");if(!File.Exists(path))throw new InvalidOperationException("Tailscale을 설치하고 같은 계정으로 로그인해 주세요.");return path;}
  static string CaptureTool(string exe,string args) {
   var info=new ProcessStartInfo(exe,args){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
   using(var p=Process.Start(info)){var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();if(!Task.WaitAll(new Task[]{output,error},20000)||!p.WaitForExit(1000)){p.Kill();throw new InvalidOperationException("연결 도구의 응답을 기다리는 중입니다.");}if(p.ExitCode!=0)throw new InvalidOperationException("연결 도구 설정을 확인해 주세요.");return output.Result;}
  }
  async Task FindPcOrigin() {
   try {var exe=Tailscale();var text=await Task.Run(()=>CaptureTool(exe,"status --json"));var json=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);
    var self=(Dictionary<string,object>)json["Self"];var dns=Convert.ToString(self["DNSName"]).TrimEnd('.');
    var value="https://"+dns;if(!SetupPaths.IsPrivateOrigin(value))throw new Exception();origin.Text=value;
   }catch(Exception){MessageBox.Show(this,"Tailscale을 설치하고 기존 PC와 같은 계정으로 로그인한 뒤 다시 눌러 주세요.","지식서재");}
  }
  async void ConfigureServe() {
   try {
    var exe=Tailscale();var state=await Task.Run(()=>CaptureTool(exe,"serve status --json"));
    var disposition=Profile.ServeDisposition(state);
    if(disposition=="conflict"){MessageBox.Show(this,"이 PC의 기존 Tailscale 공유 설정을 유지했습니다. 기존 연결을 먼저 확인해 주세요.","지식서재");return;}
    if(disposition=="empty")await Task.Run(()=>CaptureTool(exe,"serve --bg http://127.0.0.1:3001"));await FindPcOrigin();
    MessageBox.Show(this,"비공개 연결을 설정했습니다. 새 PC 주소를 로그인 서비스의 허용 주소에 등록한 뒤 로그인해 주세요.","지식서재");
   }catch(Exception){MessageBox.Show(this,"Tailscale 로그인·HTTPS 사용 승인을 확인한 뒤 다시 눌러 주세요.","지식서재");}
  }
  async void InstallOcr() {
   try {
    var script=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"install-ocr-languages.ps1");
    var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -ExecutionPolicy Bypass -File "+Quote(script)){UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden};
    using(var p=Process.Start(info)){await Task.Run(()=>p.WaitForExit());MessageBox.Show(this,p.ExitCode==0?"한국어·영어 OCR 설치를 확인했습니다.":p.ExitCode==3010?"OCR 설치 후 Windows를 다시 시작해 주세요.":"OCR 기능 설치를 완료하지 못했습니다. Windows 업데이트 연결과 관리자 승인을 확인해 주세요.","지식서재");}
   }catch(Exception){MessageBox.Show(this,"OCR 설치에는 Windows 관리자 승인이 필요합니다. 나중에 다시 실행할 수 있습니다.","지식서재");}
  }
  static string Quote(string value) {if(value.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new InvalidOperationException();return "\""+value.TrimEnd('\\')+"\"";}
  async Task Install() {
   if(busy)return;string stage=null;
   try {
    var installPath=SetupPaths.Absolute(install.Text);var dataPath=SetupPaths.Absolute(data.Text);var pdfPath=SetupPaths.Absolute(pdf.Text);
    if(!Directory.Exists(pdfPath))throw new InvalidOperationException("외장하드의 PDF 원본 폴더를 선택해 주세요.");
    if(!SetupPaths.IsPrivateOrigin(origin.Text.Trim()))throw new InvalidOperationException("Tailscale 로그인 후 PC 주소 찾기를 눌러 주세요.");
    var profile=ConnectionVault.Decrypt(File.ReadAllBytes(connection.Text.Trim()),password.Text);password.Clear();
    stage=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"KnowledgeLibrarySetup",Guid.NewGuid().ToString());
    Directory.CreateDirectory(stage);var profilePath=Path.Combine(stage,"connection.dpapi.json");
    File.WriteAllText(profilePath,Profile.Protect(profile),new UTF8Encoding(false));profile.Clear();
    var request=Path.Combine(stage,"request.json");
    File.WriteAllText(request,Profile.Serialize(new{installRoot=installPath,dataRoot=dataPath,pdfRoot=pdfPath,origin=origin.Text.Trim(),profileFile=profilePath}),new UTF8Encoding(false));
    busy=true;run.Enabled=false;progress.Visible=true;log.Clear();
    var script=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"setup-worker.ps1");
    var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Quote(script)+" -RequestPath "+Quote(request)){
     UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
    foreach(var key in info.EnvironmentVariables.Keys.Cast<string>().ToArray())if(key.StartsWith("LIBRARY_")||Profile.Allowed.Contains(key)||key.StartsWith("OPENAI_")||key.StartsWith("PG")||key.StartsWith("NEON_")||key=="NODE_OPTIONS")info.EnvironmentVariables.Remove(key);
    using(var worker=new Process {StartInfo=info}) {
     worker.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs e){if(e.Data!=null)Append(e.Data);};
     worker.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs e){if(e.Data!=null)Append(e.Data);};
     worker.Start();worker.BeginOutputReadLine();worker.BeginErrorReadLine();await Task.Run(()=>worker.WaitForExit());
     if(worker.ExitCode!=0)throw new InvalidOperationException("설치를 마치지 못했습니다. 위의 마지막 오류를 확인한 뒤 다시 실행해 주세요.");
    }
    Append("PC 준비가 끝났습니다. Google 로그인 후 PDF 보관 폴더 설정에서 연결 검사 → 이 위치로 저장을 진행하세요. 드라이브 문자가 바뀌었으면 반드시 다시 연결해야 합니다.");
   }catch(Exception e){MessageBox.Show(this,e is InvalidOperationException?e.Message:"선택한 파일·암호·폴더를 확인해 주세요.","지식서재");}
   finally {busy=false;run.Enabled=true;progress.Visible=false;if(stage!=null){foreach(var name in new[]{"request.json","connection.dpapi.json"})try{File.Delete(Path.Combine(stage,name));}catch{};try{Directory.Delete(stage);}catch{}}}
  }
 }
 public static class SetupProgram {
  [STAThread] public static int Main(string[] args) {
   if(args.Length>=1&&args[0]=="--self-test-ui") {Application.EnableVisualStyles();using(var f=new SetupForm()){f.Show();Application.DoEvents();if(f.Controls.Count==0)return 1;if(args.Length==2)using(var image=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(image,new Rectangle(0,0,f.Width,f.Height));image.Save(args[1]);}f.Close();}return 0;}
   bool first;using(var mutex=new System.Threading.Mutex(true,"Local\\KnowledgeLibraryPcSetup-"+WindowsIdentity.GetCurrent().User.Value,out first)) {
    if(!first)return 0;
    try {Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);using(var f=new SetupForm()){if(args.Length==1&&args[0]=="--export")f.SelectExport();Application.Run(f);}return 0;}
    finally {mutex.ReleaseMutex();}
   }
  }
 }
}
