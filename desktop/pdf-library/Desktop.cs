using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Web.Script.Serialization;

partial class PdfDesktop : Window {
    readonly string python, worker, index, root, data;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=32000000 };
    readonly TextBox query=new TextBox(), doc=new TextBox(), page=new TextBox { Text="1",Width=55 };
    readonly ComboBox kind=new ComboBox();
    readonly TextBlock status=new TextBlock { Text="검색어를 입력하세요." };
    readonly ProgressBar activity=new ProgressBar {Height=4};
    readonly ListBox results=new ListBox();
    readonly Image image=new Image { Stretch=Stretch.Uniform };
    Process current;
    WorkerJob currentJob;
    int ticket;
    static readonly string[] kinds={"","book","paper","periodical","review"};
    static Button Btn(string title,Action run) {
        var b=new Button {Content=title,Padding=new Thickness(9,4,9,4),Margin=new Thickness(3)};
        b.Click+=(s,e)=>run();return b;
    }
    public PdfDesktop(string[] args){
        python=args[0];worker=args[1];index=args[2];root=args[3];data=args[4];
        Title="전자도서관 · PDF 검색"; Width=960;Height=720;
        var main=new DockPanel {Margin=new Thickness(16)};Content=main;
        var bar=new StackPanel();DockPanel.SetDock(bar,Dock.Top);main.Children.Add(bar);
        bar.Children.Add(new TextBlock { Text="전자도서관 원문 검색",FontSize=23,FontWeight=FontWeights.Bold });
        bar.Children.Add(new TextBlock {Text="검색어 (모든 단어 포함 · 큰따옴표로 어구 지정)"});bar.Children.Add(query);
        var filters=new WrapPanel();bar.Children.Add(filters);
        foreach(var k in new[]{"전체","도서","논문·아티클","간행물","검토"})kind.Items.Add(k);
        kind.SelectedIndex=0;filters.Children.Add(kind);
        filters.Children.Add(new TextBlock{Text="  문서 ID (선택)  ",VerticalAlignment=VerticalAlignment.Center});
        doc.Width=265;filters.Children.Add(doc);filters.Children.Add(Btn("검색",Search));filters.Children.Add(Btn("취소",Cancel));
        var tools=new WrapPanel();bar.Children.Add(tools);
        tools.Children.Add(Btn("폴더 검산 / 이어하기",()=>Work("scan")));
        tools.Children.Add(Btn("선택 목록 모의 검증",()=>Work("preview")));
        tools.Children.Add(Btn("HTTPS 전송 목록 점검",CheckManifest));
        tools.Children.Add(Btn("사본 OCR 한 쪽 검수",Ocr));
        bar.Children.Add(new TextBlock {Text="모의 검증은 이 PC에서만 실행됩니다. 디스크 분리나 스캔 중단은 삭제 승인이 아닙니다."});
        bar.Children.Add(activity);bar.Children.Add(status);
        var row=new WrapPanel();bar.Children.Add(row);
        row.Children.Add(new TextBlock{Text="선택한 PDF 쪽  "});row.Children.Add(page);row.Children.Add(Btn("쪽 열기",Render));
        var grid=new Grid();grid.ColumnDefinitions.Add(new ColumnDefinition());grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(results);Grid.SetColumn(image,1);grid.Children.Add(image);main.Children.Add(grid);
        results.SelectionChanged+=(s,e)=>{var item=results.SelectedItem as ListBoxItem;if(item!=null)page.Text=Val((Dictionary<string,object>)item.Tag,"page");};
        results.MouseDoubleClick+=(s,e)=>Render();
        query.KeyDown+=(s,e)=>{if(e.Key==System.Windows.Input.Key.Enter)Search();};
        Closing+=(s,e)=>Cancel();
    }
    static string Val(Dictionary<string,object> d,string key){return Convert.ToString(d[key]);}
    static string Label(string code){
        switch(code){
            case "book":return "단행본"; case "paper":return "논문·아티클";case "periodical":return "간행물";case "review":return "분류 검토";
            case "ready":return "색인 완료";case "partial_ocr":return "부분 OCR";case "ocr_review":return "OCR 검토 중";case "needs_ocr":return "OCR 필요";case "indexing":return "부분 색인";
            case "text":return "PDF 텍스트";case "ocr_unverified":return "미검수 OCR";default:return code;
        }
    }
    void Cancel(){ ticket++; if(currentJob!=null){currentJob.Dispose();currentJob=null;}
        activity.IsIndeterminate=false;status.Text="작업 중단"; }
    async Task<Dictionary<string,object>> Call(Dictionary<string,object> req,int seconds){
        Cancel();int my=ticket;activity.IsIndeterminate=true;status.Text="처리 중…";
        var info=new ProcessStartInfo(python,"-B \""+worker+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        info.EnvironmentVariables["PYTHONUTF8"]="1";
        using(var p=new Process {StartInfo=info}){
            WorkerJob job=null;
            try{
                job=new WorkerJob();currentJob=job;info.EnvironmentVariables["PDF_DESKTOP_JOB"]=job.Name;
                p.Start();current=p;
                p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Dispatcher.BeginInvoke(new Action(()=>{if(ticket==my)status.Text=e.Data;}));};p.BeginErrorReadLine();
                // ASCII JSON transported without a console code-page dependency.
                var bytes=Encoding.UTF8.GetBytes(json.Serialize(req));p.StandardInput.BaseStream.Write(bytes,0,bytes.Length);p.StandardInput.Close();
                var read=p.StandardOutput.ReadToEndAsync();
                if(await Task.WhenAny(read,Task.Delay(TimeSpan.FromSeconds(seconds)))!=read){job.Dispose();throw new TimeoutException("처리 제한 시간에 도달했습니다.");}
                var value=await read;if(my!=ticket)return null;
                var r=json.Deserialize<Dictionary<string,object>>(value);
                if(r==null || r.ContainsKey("error"))throw new Exception(r==null?"응답이 없습니다.":Val(r,"error"));
                status.Text="완료";return r;
            }catch(Exception ex){if(my==ticket)status.Text=ex.Message;return null;}
            finally{if(job!=null)job.Dispose();if(currentJob==job)currentJob=null;if(my==ticket)activity.IsIndeterminate=false;if(current==p)current=null;}
        }
    }
    async void Search(){
        var req=new Dictionary<string,object>{{"action","search"},{"index",index},{"side",Path.Combine(data,"desktop-registry-v2.sqlite")},{"query",query.Text},{"kind",kinds[kind.SelectedIndex]},{"document",doc.Text.Trim()}};
        var r=await Call(req,15);if(r==null)return;
        results.Items.Clear();image.Source=null;
        foreach(Dictionary<string,object> hit in (IEnumerable)r["hits"]){
            var t=new TextBlock{TextWrapping=TextWrapping.Wrap};
            t.Inlines.Add(new Bold(new Run(Val(hit,"title")+" · "+Val(hit,"page")+"쪽\n")));
            t.Inlines.Add(new Run(Label(Val(hit,"kind"))+" · "+Label(Val(hit,"status"))+" · "+Label(Val(hit,"method"))+" · "+((bool)hit["available"]?"파일 연결됨":"위치 미확인")+"\n"));
            var pattern=new List<string>();foreach(string term in (IEnumerable)r["terms"])pattern.Add(System.Text.RegularExpressions.Regex.Escape(term));
            var snippet=Val(hit,"snippet");int pos=0;
            foreach(System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(snippet,String.Join("|",pattern),System.Text.RegularExpressions.RegexOptions.IgnoreCase)){
                t.Inlines.Add(new Run(snippet.Substring(pos,m.Index-pos)));t.Inlines.Add(new Bold(new Run(m.Value)){Background=Brushes.Khaki});pos=m.Index+m.Length;
            }t.Inlines.Add(new Run(snippet.Substring(pos)));
            results.Items.Add(new ListBoxItem{Content=t,Tag=hit,ToolTip=Val(hit,"id")});
        } status.Text=results.Items.Count+"쪽 표시 (최대 40쪽)";
    }
    async void Render(){var item=results.SelectedItem as ListBoxItem;int number;
        if(item==null||!Int32.TryParse(page.Text,out number))return;
        var r=await Call(new Dictionary<string,object>{{"action","render"},{"index",index},{"document",Val((Dictionary<string,object>)item.Tag,"id")},{"page",number},{"side",Path.Combine(data,"desktop-registry-v2.sqlite")}},20);
        if(r!=null){var bmp=new BitmapImage();bmp.BeginInit();bmp.CacheOption=BitmapCacheOption.OnLoad;using(var stream=new MemoryStream(Convert.FromBase64String(Val(r,"image")))){bmp.StreamSource=stream;bmp.EndInit();}image.Source=bmp;status.Text=number+" / "+Val(r,"total")+"쪽";}
    }
    async void Work(string action){
        var r=await Call(new Dictionary<string,object>{{"action",action},{"index",index},{"root",root},{"directory",data}},86400);
        if(r!=null)status.Text=action=="scan"?"폴더 검산 완료 · 파일 "+Val(r,"files")+"개 · 이번 해시 검사 "+Val(r,"hashed")+"개":"모의 등록 완료 · 선택 파일 "+Val(r,"physical")+"개 · 고유 문서 "+Val(r,"unique")+"개";
    }
    async void CheckManifest(){
        var r=await Call(new Dictionary<string,object>{{"action","audit-v2"},{"index",index},{"root",root},{"directory",data}},86400);
        if(r!=null)status.Text=(bool)r["localContractValid"]?"로컬 점검 완료 · 선택 파일 "+Val(r,"physicalFiles")+"개 · 고유 문서 "+Val(r,"uniqueDocuments")+"개":"전송 준비 보류 · "+Val(r,"contractError");
    }
    async void Ocr(){
        var id=doc.Text.Trim();var item=results.SelectedItem as ListBoxItem;
        if(id.Length==0 && item!=null)id=Val((Dictionary<string,object>)item.Tag,"id");
        if(id.Length==0){status.Text="검수할 문서 ID를 입력하거나 결과를 선택하세요.";return;}
        var r=await Call(new Dictionary<string,object>{{"action","ocr"},{"index",index},{"directory",data},{"document",id}},150);
        if(r!=null){status.Text="검수 사본 · "+json.Serialize(r["counts"]);MessageBox.Show(json.Serialize(r["candidates"]),"사본 검수 후보");}
    }
    [STAThread] static void Main(string[] args){if(args.Length!=5){MessageBox.Show("시작 바로가기 또는 README의 실행 명령을 사용하세요.");return;}var app=new Application();var window=new PdfDesktop(args);
        app.Run(window);}
}
