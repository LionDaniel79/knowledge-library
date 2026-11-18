using System;
using System.Windows;
class DesktopCollectionSmoke {
    [STAThread] static int Main(string[] args){
        var application=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
        var window=new PdfDesktop(new[]{args[0],args[1],"-",args[2],args[3]});
        window.ShowInTaskbar=false;window.Left=-10000;
        int result=0;
        window.ContentRendered+=(s,e)=>{try{window.InspectCollection(args[4]);Console.WriteLine("PASS collection menus/settings/pause/halt/persistence");}catch(Exception ex){Console.Error.WriteLine(ex);result=1;}finally{window.ExitApplication();}};
        application.Run(window);return result;
    }
}
