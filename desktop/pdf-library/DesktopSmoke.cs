using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Threading.Tasks;

partial class PdfDesktop {
    public async Task Inspect(string screenshot){
        query.Text="영적인 사람";Search();
        for(int i=0;i<120 && current!=null;i++)await Task.Delay(150);
        if(results.Items.Count<1)throw new Exception("WPF search: "+status.Text);
        results.SelectedIndex=0;Render();
        for(int i=0;i<160 && current!=null;i++)await Task.Delay(150);
        if(image.Source==null)throw new Exception("WPF render: "+status.Text);
        UpdateLayout();
        var bmp=new RenderTargetBitmap((int)ActualWidth,(int)ActualHeight,96,96,PixelFormats.Pbgra32);
        bmp.Render(this);var enc=new PngBitmapEncoder();enc.Frames.Add(BitmapFrame.Create(bmp));
        using(var f=new FileStream(screenshot,FileMode.CreateNew))enc.Save(f);
        Search();Cancel();
        if(current!=null && !current.HasExited)current.WaitForExit(2500);
        if(current!=null && !current.HasExited)throw new Exception("Worker cancellation failed.");
    }
}
class DesktopSmoke {
    [STAThread] static int Main(string[] args){
        var app=new Application();var window=new PdfDesktop(args);
        window.ShowInTaskbar=false;window.WindowStartupLocation=WindowStartupLocation.Manual;window.Left=-12000;window.Top=0;
        int result=0;
        window.ContentRendered+=async(s,e)=>{try{await window.Inspect(args[5]);}
            catch(Exception ex){Console.Error.WriteLine(ex);result=1;}finally{window.Close();}};
        app.Run(window);return result;
    }
}
