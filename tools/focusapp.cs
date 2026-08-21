using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

// Agent Board 窗口激活工具：用法 FocusApp.exe <进程名>
// 组合：恢复最小化 + Alt 模拟解前台锁 + SetForegroundWindow + BringWindowToTop（两次）
class FocusApp {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e);

    static int Main(string[] args) {
        string name = args.Length > 0 ? args[0] : "";
        if (name.Length == 0) { Console.WriteLine("NO_NAME"); return 1; }
        IntPtr h = IntPtr.Zero;
        try {
            Process[] ps = Process.GetProcessesByName(name);
            foreach (var p in ps) {
                if (p.MainWindowHandle != IntPtr.Zero) { h = p.MainWindowHandle; }
                p.Dispose();
            }
        } catch { h = IntPtr.Zero; }
        if (h == IntPtr.Zero) { Console.WriteLine("NOT_RUNNING"); return 0; }
        if (IsIconic(h)) ShowWindow(h, 9);                 // SW_RESTORE
        keybd_event(0x12, 0, 0, UIntPtr.Zero);            // Alt down
        keybd_event(0x12, 0, 2, UIntPtr.Zero);            // Alt up
        SetForegroundWindow(h);
        BringWindowToTop(h);
        Thread.Sleep(120);
        SetForegroundWindow(h);
        Console.WriteLine("OK");
        return 0;
    }
}
