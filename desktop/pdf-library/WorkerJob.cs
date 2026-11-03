using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// The Python interpreter attaches itself before reading the request. This also
// covers Windows virtual environments whose python.exe is only a redirector.
sealed class WorkerJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    struct Basic {public long perProcess,perJob;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
    [StructLayout(LayoutKind.Sequential)]
    struct Extended {public Basic basic; public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;public UIntPtr processMem,jobMem,processPeak,jobPeak;}
    [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern SafeFileHandle CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32",SetLastError=true)]
    static extern bool SetInformationJobObject(SafeFileHandle job,int info,ref Extended value,uint size);
    public readonly string Name="Local\\KnowledgeLibrary-"+Guid.NewGuid().ToString("N");
    readonly SafeFileHandle handle;
    public WorkerJob(){
        handle=CreateJobObject(IntPtr.Zero,Name);
        var v=new Extended();v.basic.flags=0x2000;
        if(handle.IsInvalid || !SetInformationJobObject(handle,9,ref v,(uint)Marshal.SizeOf(typeof(Extended)))){
            int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);
        }
    }
    public void Dispose(){handle.Dispose();}
}
