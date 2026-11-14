using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;

partial class PdfDesktop {
    class CollectionView {
        public TextBox Limit=new TextBox{Width=90,Margin=new Thickness(4)};
        public TextBlock Summary=new TextBlock{TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4,16,4,12),FontSize=16};
        public TextBlock Detail=new TextBlock{TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4)};
        public Button Pause;
    }
    readonly Dictionary<string,CollectionView> collectionViews=new Dictionary<string,CollectionView>();
    string collectionDirectory="";
    WorkerJob collectionJob;
    Process collectionProcess;
    void BuildCollectionTabs(TabControl tabs){
        foreach(var kind in new[]{"pdf","logos"}){
            var key=kind;var view=new CollectionView();collectionViews[key]=view;
            var panel=new StackPanel{Margin=new Thickness(20)};
            panel.Children.Add(new TextBlock{Text=(key=="pdf"?"PDF":"로고스")+" 도서정보·표지 수집",FontSize=23,FontWeight=FontWeights.Bold});
            panel.Children.Add(new TextBlock{Text="유력한 서지정보를 웹 서재에 자동 보완합니다. 적용 내역은 웹에서 확인하고 항목별로 되돌릴 수 있습니다.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4,12,4,12)});
            var row=new WrapPanel();panel.Children.Add(row);
            row.Children.Add(new TextBlock{Text="하루 신규 조사 한도",VerticalAlignment=VerticalAlignment.Center});row.Children.Add(view.Limit);
            row.Children.Add(Btn("한도 저장",()=>SaveCollectionLimit(key)));
            panel.Children.Add(new TextBlock{Text="0권은 일시정지 · "+(key=="pdf"?"최대 500권":"최대 600권")+" · 한 배치 최대 100권 · API 호출 한도는 별도로 유지됩니다.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4)});
            var actions=new WrapPanel();panel.Children.Add(actions);
            actions.Children.Add(Btn("지금 수집",()=>RequestCollection(key)));
            view.Pause=Btn("일시정지 / 계속",()=>ToggleCollection(key));actions.Children.Add(view.Pause);
            actions.Children.Add(Btn("현황 새로고침",RefreshCollectionViews));
            panel.Children.Add(view.Summary);panel.Children.Add(view.Detail);
            panel.Children.Add(new TextBlock{Text="창을 닫아도 트레이에서 계속 실행됩니다. 화면 잠금은 가능하며, 로그아웃·절전·PC 종료 중에는 실행되지 않습니다. 다시 실행하면 체크포인트를 재사용합니다.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4,24,4,4)});
            tabs.Items.Add(new TabItem{Header=key=="pdf"?"PDF 도서정보 수집":"로고스 도서정보 수집",Content=new ScrollViewer{Content=panel,VerticalScrollBarVisibility=ScrollBarVisibility.Auto}});
        }
    }
    Dictionary<string,object> CollectionRead(string name){
        var path=Path.Combine(collectionDirectory,name);
        return File.Exists(path)?json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8)):new Dictionary<string,object>();
    }
    void CollectionWrite(string name,Dictionary<string,object> value){
        var path=Path.Combine(collectionDirectory,name);var temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{File.WriteAllText(temp,json.Serialize(value),new UTF8Encoding(false));if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);}finally{if(File.Exists(temp))File.Delete(temp);}
    }
    bool StartCollectionHost(){
        if(launchConfiguration==null || Val(launchConfiguration,"collectionConfiguration").Length==0){RefreshCollectionViews();return false;}
        try{
            var config=Val(launchConfiguration,"collectionConfiguration");
            var settings=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config,Encoding.UTF8));
            collectionDirectory=Val(settings,"stateDirectory");
            var helper=Val(settings,"host");var node=Val(settings,"node");
            if(!Directory.Exists(collectionDirectory)||!File.Exists(helper)||!File.Exists(node))throw new InvalidOperationException();
            collectionJob=new WorkerJob();
            collectionProcess=CatalogHost.Start(node,helper,config,Path.Combine(collectionDirectory,"desktop-request.json"),Path.GetDirectoryName(helper),collectionJob.Name);
            catalogStatus.Text="서지 수집은 PDF·로고스 도서정보 수집 메뉴에서 확인하세요.";
        }catch{catalogStatus.Text="수집 연결 설정을 확인하세요. PDF 검색·OCR은 계속 사용할 수 있습니다.";}
        RefreshCollectionViews();return true; // Never start the old unbounded sidecar on a bad replacement configuration.
    }
    void StopCollectionHost(){if(collectionJob!=null){collectionJob.Dispose();collectionJob=null;}if(collectionProcess!=null){collectionProcess.Dispose();collectionProcess=null;}}
    void RefreshCollectionViews(){
        foreach(var pair in collectionViews){
            var kind=pair.Key;var v=pair.Value;
            if(collectionDirectory.Length==0){v.Summary.Text="도서정보 수집 연결이 설정되지 않았습니다.";continue;}
            try{
                var settings=CollectionRead("user-settings.json");object o;
                var cfg=settings.TryGetValue(kind,out o)?(Dictionary<string,object>)o:new Dictionary<string,object>();
                var limit=cfg.ContainsKey("dailyLimit")?Convert.ToInt32(cfg["dailyLimit"]):kind=="pdf"?100:300;
                if(!v.Limit.IsKeyboardFocusWithin)v.Limit.Text=limit.ToString();
                var paused=Val(cfg,"paused")=="True";v.Pause.Content=paused?"수집 계속":"수집 일시정지";
                var day=DateTime.UtcNow.AddHours(9).ToString("yyyy-MM-dd");var ledger=CollectionRead(day+".json");
                var entry=ledger.TryGetValue(kind,out o)?(Dictionary<string,object>)o:new Dictionary<string,object>();
                var ids=entry.ContainsKey("ids")?entry["ids"] as ICollection:null;
                var status=CollectionRead(kind+"-status.json");var halted=CollectionRead("halted.json");
                var state=Val(status,"state");var running=state=="running"&&File.Exists(Path.Combine(collectionDirectory,"running.lock"));
                var host=CollectionRead("desktop-host.json");
                var hostAlive=collectionProcess!=null&&!collectionProcess.HasExited;
                v.Summary.Text=halted.Count>0?"오류로 수집 중단 · 기존 진행 기록은 보존되어 있습니다.":!hostAlive?"백그라운드 수집기가 실행되지 않았습니다. 앱을 다시 열어 주세요.":running?"도서정보 수집 중":paused||limit==0?"일시정지":"예약 대기";
                string text="오늘 조사 완료 "+(ids==null?0:ids.Count)+"권 / 일일 한도 "+limit+"권\n안전 예약 용량 "+(entry.ContainsKey("reserved")?Val(entry,"reserved"):"0")+"권 (중단된 배치 포함)";
                var result=status.ContainsKey("result")?status["result"] as Dictionary<string,object>:null;
                if(running){var live=CollectionRead("live-"+kind+".json");DateTime liveAt,startAt;if(DateTime.TryParse(Val(live,"at"),out liveAt)&&DateTime.TryParse(Val(status,"at"),out startAt)&&liveAt>=startAt)result=live;}
                if(result==null && status.ContainsKey("sequence")){
                    var sequence=status["sequence"] as Dictionary<string,object>;
                    if(sequence!=null&&sequence.ContainsKey("batches"))foreach(Dictionary<string,object> batch in (IEnumerable)sequence["batches"])result=batch;
                }
                if(result!=null){
                    text+="\n마지막 배치 조사 "+(kind=="pdf"?Val(result,"processed"):Val(result,"considered"))+" · 자동 반영 "+Val(result,"applied")+" · 검토 대기 "+Val(result,"review")+" · 후보 없음 "+Val(result,"missing")+" · 오류 "+(kind=="pdf"?Val(result,"errors"):Val(result,"failed"));
                    if(result.ContainsKey("pending"))text+="\n마지막 확인 시 남은 대상 "+Val(result,"pending");
                }
                DateTime updated;var timestamp=DateTime.TryParse(Val(status,"at"),out updated)?updated.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"):"아직 없음";
                text+="\n마지막 상태 갱신 "+timestamp+"\n예약: "+(kind=="pdf"?"매일 15:00":"매일 09:00 / 21:00")+" (한국시간, 실행 중일 때)";
                if(halted.Count>0){var failure=halted.ContainsKey("failure")?halted["failure"] as Dictionary<string,object>:null;text+="\n중단 오류: "+(failure==null?Val(halted,"name"):Val(failure,"name"))+" · 오류 원인 확인 전에는 자동 재시작하지 않습니다.";}
                if(Val(host,"state")=="error")text+="\n수집 설정 또는 상태 파일을 확인하세요.";
                v.Detail.Text=text;
            }catch{v.Summary.Text="수집 현황을 읽지 못했습니다. 설정과 저장 장치를 확인하세요.";}
        }
    }
    void SaveCollectionLimit(string kind){
        int value;var view=collectionViews[kind];
        if(!Int32.TryParse(view.Limit.Text,out value)||value<0||value>(kind=="pdf"?500:600)){MessageBox.Show("0~"+(kind=="pdf"?500:600)+"권을 입력하세요.");return;}
        ChangeCollectionSetting(kind,"dailyLimit",value);
    }
    void ChangeCollectionSetting(string kind,string field,object value){
        if(collectionDirectory.Length==0)return;
        try{var settings=CollectionRead("user-settings.json");object old;var cfg=settings.TryGetValue(kind,out old)?(Dictionary<string,object>)old:new Dictionary<string,object>();cfg[field]=value;settings[kind]=cfg;CollectionWrite("user-settings.json",settings);RefreshCollectionViews();}
        catch{MessageBox.Show("설정을 저장하지 못했습니다. 입력 내용은 유지됩니다.");}
    }
    void ToggleCollection(string kind){try{var settings=CollectionRead("user-settings.json");object old;var cfg=settings.TryGetValue(kind,out old)?(Dictionary<string,object>)old:new Dictionary<string,object>();ChangeCollectionSetting(kind,"paused",Val(cfg,"paused")!="True");}catch{MessageBox.Show("수집 설정을 확인하세요.");}}
    void RequestCollection(string kind){
        if(collectionDirectory.Length==0)return;
        try{if(CollectionRead("halted.json").Count>0){MessageBox.Show("이전 수집 오류로 중단된 상태입니다. 오류 원인을 확인한 후 재개해야 합니다. 기록은 보존됩니다.");return;}
            CollectionWrite("desktop-request.json",new Dictionary<string,object>{{"kind",kind},{"requestId",Guid.NewGuid().ToString("N")}});
            collectionViews[kind].Summary.Text="수집 요청됨 · 일일 한도와 일시정지 설정을 확인한 뒤 30초 안에 시작합니다.";
        }catch{MessageBox.Show("수집 요청을 저장하지 못했습니다.");}
    }
    internal void InspectCollection(string screenshot){
        backgroundTimer.Stop();collectionDirectory=data;
        var tabs=(TabControl)Content;if(tabs.Items.Count!=3)throw new Exception("Three separate menus required");
        CollectionWrite("user-settings.json",new Dictionary<string,object>{{"pdf",new Dictionary<string,object>{{"dailyLimit",100}}},{"logos",new Dictionary<string,object>{{"dailyLimit",300}}}});
        RefreshCollectionViews();collectionViews["pdf"].Limit.Text="37";SaveCollectionLimit("pdf");
        if(Val((Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"],"dailyLimit")!="37")throw new Exception("Daily limit did not persist");
        ToggleCollection("pdf");if(Val((Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"],"paused")!="True")throw new Exception("Pause did not persist");
        ToggleCollection("pdf");
        CollectionWrite("halted.json",new Dictionary<string,object>{{"name","TypeError"}});RefreshCollectionViews();
        if(!collectionViews["pdf"].Summary.Text.Contains("오류"))throw new Exception("Shared halt must be visible");
        tabs.SelectedIndex=1;UpdateLayout();
        var bmp=new System.Windows.Media.Imaging.RenderTargetBitmap((int)ActualWidth,(int)ActualHeight,96,96,System.Windows.Media.PixelFormats.Pbgra32);
        bmp.Render(this);var encoder=new System.Windows.Media.Imaging.PngBitmapEncoder();encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bmp));using(var file=File.Create(screenshot))encoder.Save(file);
    }
}
