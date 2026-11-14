using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Controls;

partial class PdfDesktop {
    class CollectionView {
        public TextBox Limit=new TextBox{Width=90,Margin=new Thickness(4)};
        public TextBox RunLimit=new TextBox{Width=90,Margin=new Thickness(4)};
        public TextBox Times=new TextBox{Width=210,Margin=new Thickness(4),ToolTip="한국시간, 쉼표로 구분. 예: 09:00,21:00"};
        public ComboBox Mode=new ComboBox{Width=195,Margin=new Thickness(4)};
        public bool Dirty,Loading;
        public string LoadedSettings="";
        public TextBlock Summary=new TextBlock{TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4,16,4,12),FontSize=16};
        public TextBlock Detail=new TextBlock{TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4)};
        public Button Pause,Start;
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
            var schedule=new WrapPanel();panel.Children.Add(schedule);
            schedule.Children.Add(new TextBlock{Text="실행 방식",VerticalAlignment=VerticalAlignment.Center});
            foreach(var label in new[]{"예약 없이 연속 실행","예약 시각에 실행","수동 실행만"})view.Mode.Items.Add(label);
            schedule.Children.Add(view.Mode);schedule.Children.Add(new TextBlock{Text="예약 시각",VerticalAlignment=VerticalAlignment.Center});schedule.Children.Add(view.Times);
            view.Mode.SelectionChanged+=(s,e)=>{view.Times.IsEnabled=view.Mode.SelectedIndex==1;if(!view.Loading)view.Dirty=true;};
            view.Limit.TextChanged+=(s,e)=>{if(!view.Loading)view.Dirty=true;};view.RunLimit.TextChanged+=(s,e)=>{if(!view.Loading)view.Dirty=true;};view.Times.TextChanged+=(s,e)=>{if(!view.Loading)view.Dirty=true;};
            var row=new WrapPanel();panel.Children.Add(row);
            row.Children.Add(new TextBlock{Text="하루 신규 조사 한도",VerticalAlignment=VerticalAlignment.Center});row.Children.Add(view.Limit);
            row.Children.Add(new TextBlock{Text="한 번 최대",VerticalAlignment=VerticalAlignment.Center});row.Children.Add(view.RunLimit);
            row.Children.Add(Btn("설정 저장",()=>SaveCollectionLimit(key)));
            panel.Children.Add(new TextBlock{Text="하루 0~10,000권 · 한 번 1~10,000권 · 내부적으로 100권씩 순차 처리 · API 호출 한도는 별도로 유지됩니다. 하루 0권은 일시정지입니다.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(4)});
            var actions=new WrapPanel();panel.Children.Add(actions);
            view.Start=Btn("지금 수집",()=>RequestCollection(key));actions.Children.Add(view.Start);
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
                var mode=cfg.ContainsKey("mode")?Val(cfg,"mode"):"scheduled";
                var times=new List<string>();if(cfg.ContainsKey("times"))foreach(var t in (IEnumerable)cfg["times"])times.Add(Convert.ToString(t));else times.AddRange(kind=="pdf"?new[]{"15:00"}:new[]{"09:00","21:00"});
                var signature=json.Serialize(cfg);
                if(!v.Dirty && signature!=v.LoadedSettings){v.Loading=true;try{v.Limit.Text=limit.ToString();v.RunLimit.Text=cfg.ContainsKey("runLimit")?Val(cfg,"runLimit"):"100";v.Mode.SelectedIndex=mode=="continuous"?0:mode=="manual"?2:1;v.Times.Text=String.Join(",",times);v.LoadedSettings=signature;}finally{v.Loading=false;}}
                var paused=Val(cfg,"paused")=="True";v.Pause.Content=paused?"수집 계속":"수집 일시정지";
                var day=DateTime.UtcNow.AddHours(9).ToString("yyyy-MM-dd");var ledger=CollectionRead(day+".json");
                var entry=ledger.TryGetValue(kind,out o)?(Dictionary<string,object>)o:new Dictionary<string,object>();
                var ids=entry.ContainsKey("ids")?entry["ids"] as ICollection:null;
                var status=CollectionRead(kind+"-status.json");var halted=CollectionRead("halted.json");
                var haltFailure=halted.ContainsKey("failure")?halted["failure"] as Dictionary<string,object>:null;
                var retryable=haltFailure!=null&&Val(haltFailure,"retryable")=="True";
                v.Start.Content=retryable?"중단 후 다시 시도":"지금 수집";
                var state=Val(status,"state");var running=state=="running"&&File.Exists(Path.Combine(collectionDirectory,"running.lock"));
                var host=CollectionRead("desktop-host.json");
                var hostAlive=collectionProcess!=null&&!collectionProcess.HasExited;
                v.Summary.Text=halted.Count>0?"오류로 수집 중단 · 기존 진행 기록은 보존되어 있습니다.":!hostAlive?"백그라운드 수집기가 실행되지 않았습니다. 앱을 다시 열어 주세요.":running?"도서정보 수집 중":paused||limit==0?"일시정지":mode=="continuous"?"연속 실행 대기":mode=="manual"?"수동 실행 대기":"예약 대기";
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
                text+="\n마지막 상태 갱신 "+timestamp+"\n실행 방식: "+(mode=="continuous"?"예약 없이 연속 실행":mode=="manual"?"수동 실행만":"예약 "+String.Join(" / ",times)+" (한국시간)")+" · 한 번 최대 "+(cfg.ContainsKey("runLimit")?Val(cfg,"runLimit"):"100")+"권";
                text+="\n조사 대상이 없으면 1시간 대기합니다. PDF와 로고스는 동시에 실행되지 않습니다.";
                if(halted.Count>0){var failure=halted.ContainsKey("failure")?halted["failure"] as Dictionary<string,object>:null;text+="\n중단 원인: "+(failure!=null&&Val(failure,"kind")=="database-timeout"?"DB 응답 시간 초과":failure!=null&&Val(failure,"kind")=="network"?"외부 연결 오류":failure==null?"상세 원인 기록이 없는 오류":Val(failure,"name"))+" · "+(retryable?"연결이 회복되면 ‘중단 후 다시 시도’를 누르세요.":"원인 확인이 필요합니다. 진행 기록은 보존됩니다.");}
                if(Val(host,"state")=="error")text+="\n수집 설정 또는 상태 파일을 확인하세요.";
                v.Detail.Text=text;
            }catch{v.Summary.Text="수집 현황을 읽지 못했습니다. 설정과 저장 장치를 확인하세요.";}
        }
    }
    void SaveCollectionLimit(string kind){
        int daily,perRun;var view=collectionViews[kind];
        if(!Int32.TryParse(view.Limit.Text,out daily)||daily<0||daily>10000||!Int32.TryParse(view.RunLimit.Text,out perRun)||perRun<1||perRun>10000){MessageBox.Show("하루는 0~10,000권, 한 번은 1~10,000권을 입력하세요.");return;}
        var times=view.Times.Text.Split(',').Select(t=>t.Trim()).ToArray();
        if(times.Length<1||times.Length>8||times.Distinct().Count()!=times.Length||times.Any(t=>!System.Text.RegularExpressions.Regex.IsMatch(t,@"^([01]\d|2[0-3]):[0-5]\d$"))){MessageBox.Show("예약 시각을 00:00~23:59 형식으로 입력하세요. 여러 시각은 쉼표로 구분합니다(최대 8개).");return;}
        if(collectionDirectory.Length==0)return;
        try{var settings=CollectionRead("user-settings.json");object old;var cfg=settings.TryGetValue(kind,out old)?(Dictionary<string,object>)old:new Dictionary<string,object>();cfg["dailyLimit"]=daily;cfg["runLimit"]=perRun;cfg["mode"]=view.Mode.SelectedIndex==0?"continuous":view.Mode.SelectedIndex==2?"manual":"scheduled";cfg["times"]=times;settings[kind]=cfg;CollectionWrite("user-settings.json",settings);view.Dirty=false;view.LoadedSettings="";RefreshCollectionViews();}catch{MessageBox.Show("설정을 저장하지 못했습니다. 입력 내용은 유지됩니다.");}
    }
    void ChangeCollectionSetting(string kind,string field,object value){
        if(collectionDirectory.Length==0)return;
        try{var settings=CollectionRead("user-settings.json");object old;var cfg=settings.TryGetValue(kind,out old)?(Dictionary<string,object>)old:new Dictionary<string,object>();cfg[field]=value;settings[kind]=cfg;CollectionWrite("user-settings.json",settings);RefreshCollectionViews();}
        catch{MessageBox.Show("설정을 저장하지 못했습니다. 입력 내용은 유지됩니다.");}
    }
    void ToggleCollection(string kind){try{var settings=CollectionRead("user-settings.json");object old;var cfg=settings.TryGetValue(kind,out old)?(Dictionary<string,object>)old:new Dictionary<string,object>();ChangeCollectionSetting(kind,"paused",Val(cfg,"paused")!="True");}catch{MessageBox.Show("수집 설정을 확인하세요.");}}
    void RequestCollection(string kind){
        if(collectionDirectory.Length==0)return;
        try{
            var halt=CollectionRead("halted.json");string retryAt="";
            if(halt.Count>0){var failure=halt.ContainsKey("failure")?halt["failure"] as Dictionary<string,object>:null;
                if(failure==null||Val(failure,"retryable")!="True"){MessageBox.Show("이 중단은 원인 확인이 필요합니다. 반복 실행하지 말고 중단 원인을 확인하세요. 진행 기록은 보존됩니다.");return;}
                if(MessageBox.Show("일시적인 연결 오류 후 수집을 다시 시도할까요? 기존 진행 기록과 한도를 유지하며, 다시 실패하면 중단합니다.","수집 다시 시도",MessageBoxButton.YesNo)!=MessageBoxResult.Yes)return;
                retryAt=Val(halt,"at");var failedKind=Val(halt,"kind");if(failedKind=="pdf"||failedKind=="logos")kind=failedKind;
            }
            var request=new Dictionary<string,object>{{"kind",kind},{"requestId",Guid.NewGuid().ToString("N")}};
            if(retryAt.Length>0)request["retryHaltAt"]=retryAt;
            CollectionWrite("desktop-request.json",request);
            collectionViews[kind].Summary.Text="수집 요청됨 · 일일 한도와 일시정지 설정을 확인한 뒤 30초 안에 시작합니다.";
        }catch{MessageBox.Show("수집 요청을 저장하지 못했습니다.");}
    }
    internal void InspectCollection(string screenshot){
        backgroundTimer.Stop();collectionDirectory=data;
        var tabs=(TabControl)Content;if(tabs.Items.Count!=3)throw new Exception("Three separate menus required");
        CollectionWrite("user-settings.json",new Dictionary<string,object>{{"pdf",new Dictionary<string,object>{{"dailyLimit",100}}},{"logos",new Dictionary<string,object>{{"dailyLimit",300}}}});
        RefreshCollectionViews();collectionViews["pdf"].Limit.Text="37";SaveCollectionLimit("pdf");
        if(Val((Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"],"dailyLimit")!="37")throw new Exception("Daily limit did not persist");
        collectionViews["pdf"].RunLimit.Text="250";collectionViews["pdf"].Mode.SelectedIndex=0;SaveCollectionLimit("pdf");
        if(Val((Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"],"mode")!="continuous")throw new Exception("Continuous mode did not persist");
        collectionViews["pdf"].Mode.SelectedIndex=1;collectionViews["pdf"].Times.Text="08:15,20:40";SaveCollectionLimit("pdf");
        var saved=(Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"];
        if(Val(saved,"runLimit")!="250"||((ICollection)saved["times"]).Count!=2)throw new Exception("Custom schedule or per-run limit missing");
        collectionViews["pdf"].Limit.Text="1000";RefreshCollectionViews();if(collectionViews["pdf"].Limit.Text!="1000")throw new Exception("Refresh overwrote an unsaved setting");
        collectionViews["pdf"].Mode.SelectedIndex=0;SaveCollectionLimit("pdf");
        ToggleCollection("pdf");if(Val((Dictionary<string,object>)CollectionRead("user-settings.json")["pdf"],"paused")!="True")throw new Exception("Pause did not persist");
        ToggleCollection("pdf");
        CollectionWrite("halted.json",new Dictionary<string,object>{{"name","TypeError"}});RefreshCollectionViews();
        if(!collectionViews["pdf"].Summary.Text.Contains("오류"))throw new Exception("Shared halt must be visible");
        CollectionWrite("halted.json",new Dictionary<string,object>{{"kind","pdf"},{"at","fixture"},{"failure",new Dictionary<string,object>{{"name","Error"},{"kind","database-timeout"},{"retryable",true}}}});RefreshCollectionViews();
        if(Convert.ToString(collectionViews["pdf"].Start.Content)!="중단 후 다시 시도"||!collectionViews["pdf"].Detail.Text.Contains("DB 응답 시간 초과"))throw new Exception("Recoverable halt must offer a clear retry action");
        tabs.SelectedIndex=1;UpdateLayout();
        var bmp=new System.Windows.Media.Imaging.RenderTargetBitmap((int)ActualWidth,(int)ActualHeight,96,96,System.Windows.Media.PixelFormats.Pbgra32);
        bmp.Render(this);var encoder=new System.Windows.Media.Imaging.PngBitmapEncoder();encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bmp));using(var file=File.Create(screenshot))encoder.Save(file);
    }
}
