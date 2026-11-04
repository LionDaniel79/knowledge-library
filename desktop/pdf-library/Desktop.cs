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
    readonly TextBlock status=new TextBlock { Text="검색어를 입력하세요.",TextWrapping=TextWrapping.Wrap };
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
        python=args[0];worker=args[1];index=args[2]=="-"?"":args[2];root=args[3];data=args[4];
        Title="전자도서관 · PDF 서재"; Width=1120;Height=820;MinWidth=850;MinHeight=600;
        var main=new DockPanel {Margin=new Thickness(16)};Content=main;
        var bar=new StackPanel();DockPanel.SetDock(bar,Dock.Top);main.Children.Add(bar);
        bar.Children.Add(new TextBlock { Text="전자도서관 PDF 서재",FontSize=23,FontWeight=FontWeights.Bold });
        BuildManagement(bar);
        bar.Children.Add(new TextBlock {Text="원문 검색 · 모든 단어 포함 · 큰따옴표로 어구 지정",Margin=new Thickness(0,10,0,0)});bar.Children.Add(query);
        var filters=new WrapPanel();bar.Children.Add(filters);
        foreach(var k in new[]{"전체","도서","논문·아티클","간행물","검토"})kind.Items.Add(k);
        kind.SelectedIndex=0;filters.Children.Add(kind);
        filters.Children.Add(new TextBlock{Text="  문서 ID (선택)  ",VerticalAlignment=VerticalAlignment.Center});
        doc.Width=265;filters.Children.Add(doc);filters.Children.Add(Btn("검색",Search));filters.Children.Add(Btn("검색 취소",Cancel));
        bar.Children.Add(activity);bar.Children.Add(status);
        var row=new WrapPanel();bar.Children.Add(row);
        row.Children.Add(new TextBlock{Text="선택한 PDF 쪽  "});row.Children.Add(page);row.Children.Add(Btn("쪽 열기",Render));
        var grid=new Grid();grid.ColumnDefinitions.Add(new ColumnDefinition());grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(results);Grid.SetColumn(image,1);grid.Children.Add(image);main.Children.Add(grid);
        results.SelectionChanged+=(s,e)=>{var item=results.SelectedItem as ListBoxItem;if(item!=null)page.Text=Val((Dictionary<string,object>)item.Tag,"page");};
        results.MouseDoubleClick+=(s,e)=>Render();
        query.KeyDown+=(s,e)=>{if(e.Key==System.Windows.Input.Key.Enter)Search();};
        StartManagement();
    }
    static string Val(Dictionary<string,object> d,string key){object v;return d.TryGetValue(key,out v)?Convert.ToString(v):"";}
    static string Label(string code){
        switch(code){
            case "book":return "단행본"; case "paper":return "논문·아티클";case "periodical":return "간행물";case "review":return "분류 검토";
            case "ready":return "색인 완료";case "partial_ocr":return "부분 OCR";case "ocr_review":return "OCR 검토 중";case "needs_ocr":return "OCR 필요";case "indexing":return "부분 색인";
            case "text":return "PDF 텍스트";case "ocr_unverified":return "미검수 OCR";default:return code;
        }
    }
    void Cancel(){ticket++;if(currentJob!=null){currentJob.Dispose();currentJob=null;}activity.IsIndeterminate=false;status.Text="검색을 중단했습니다.";}
    async Task<Dictionary<string,object>> Call(Dictionary<string,object> req,int seconds){
        Cancel();int my=ticket;activity.IsIndeterminate=true;status.Text="검색 처리 중…";
        try {var r=await RunWorker(req,seconds,0);if(my!=ticket)return null;status.Text="완료";return r;}
        catch(Exception ex){if(my==ticket)status.Text=ex.Message;return null;}
        finally{if(my==ticket)activity.IsIndeterminate=false;}
    }
    Dictionary<string,object> Request(string action){return new Dictionary<string,object>{{"action","library-"+action},{"directory",data}};}
    void AddIndex(Dictionary<string,object> req){if(!String.IsNullOrWhiteSpace(index))req["index"]=index;}
    async void Search(){
        var req=Request("search");AddIndex(req);req["query"]=query.Text;req["kind"]=kinds[kind.SelectedIndex];req["document"]=doc.Text.Trim();
        var r=await Call(req,15);if(r==null)return;
        results.Items.Clear();image.Source=null;
        foreach(Dictionary<string,object> hit in (IEnumerable)r["hits"]){
            var t=new TextBlock{TextWrapping=TextWrapping.Wrap};
            t.Inlines.Add(new Bold(new Run(Val(hit,"title")+" · "+Val(hit,"page")+"쪽\n")));
            t.Inlines.Add(new Run(Label(Val(hit,"kind"))+" · "+Label(Val(hit,"status"))+" · "+Label(Val(hit,"method"))+" · "+((bool)hit["available"]?"파일 연결됨":"위치 미확인")+"\n"));
            var pattern=new List<string>();foreach(string term in (IEnumerable)r["terms"])pattern.Add(System.Text.RegularExpressions.Regex.Escape(term));
            var snippet=Val(hit,"snippet");int pos=0;
            if(pattern.Count>0)foreach(System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(snippet,String.Join("|",pattern),System.Text.RegularExpressions.RegexOptions.IgnoreCase)){
                t.Inlines.Add(new Run(snippet.Substring(pos,m.Index-pos)));t.Inlines.Add(new Bold(new Run(m.Value)){Background=Brushes.Khaki});pos=m.Index+m.Length;
            }t.Inlines.Add(new Run(snippet.Substring(pos)));
            results.Items.Add(new ListBoxItem{Content=t,Tag=hit,ToolTip=Val(hit,"id")});
        } status.Text=results.Items.Count+"쪽 표시 (최대 40쪽)";
    }
    async void Render(){var item=results.SelectedItem as ListBoxItem;int number;
        if(item==null||!Int32.TryParse(page.Text,out number))return;
        var req=Request("render");AddIndex(req);req["document"]=Val((Dictionary<string,object>)item.Tag,"id");req["page"]=number;
        var r=await Call(req,25);
        if(r!=null){var bmp=new BitmapImage();bmp.BeginInit();bmp.CacheOption=BitmapCacheOption.OnLoad;using(var stream=new MemoryStream(Convert.FromBase64String(Val(r,"image")))){bmp.StreamSource=stream;bmp.EndInit();}image.Source=bmp;status.Text=number+" / "+Val(r,"total")+"쪽";}
    }
    [STAThread] static void Main(string[] args){
        try{
            args=LoadArguments(args);if(args==null)return;
            var identity=Convert.ToBase64String(System.Security.Cryptography.SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(args[4]).ToUpperInvariant()))).Replace('/','_');
            bool created;using(var mutex=new System.Threading.Mutex(true,"Local\\KnowledgeLibrary-Pdf-"+identity,out created)){
                if(!created){MessageBox.Show("PDF 서재가 실행 중입니다. 알림 영역의 책 아이콘에서 여세요.");return;}
                var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};var window=new PdfDesktop(args);app.Run(window);
            }
        }catch(Exception ex){MessageBox.Show(ex.Message,"PDF 서재 시작 확인");}
    }
}
