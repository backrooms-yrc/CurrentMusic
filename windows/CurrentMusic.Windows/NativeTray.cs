using System.Runtime.InteropServices;

namespace CurrentMusic.Windows;

internal sealed class NativeTray : IDisposable
{
    private readonly IntPtr _window;
    private readonly Action _show, _exit;
    private readonly SubclassProc _callback;
    private NotifyIconData _data;
    public bool Available { get; }
    public NativeTray(IntPtr window, Action show, Action exit)
    {
        _window = window; _show = show; _exit = exit; _callback = WindowProc;
        _data = new() { Size = (uint)Marshal.SizeOf<NotifyIconData>(), Window = window, Id = 1, Flags = 7, Callback = 0x8000 + 37, Icon = LoadIcon(IntPtr.Zero, (IntPtr)32512), Tip = "CurrentMusic · 点击恢复 / 右键菜单", Info = "", InfoTitle = "" };
        Available = SetWindowSubclass(window, _callback, 1, 0) && ShellNotifyIcon(0, ref _data);
    }
    private IntPtr WindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, nuint id, nuint reference)
    {
        if (message == 0x0024)
        {
            var limits = Marshal.PtrToStructure<MinMaxInfo>(lParam);
            var dpi = GetDpiForWindow(window);
            limits.MinTrackSize = new Point { X = (int)(760 * dpi / 96), Y = (int)(600 * dpi / 96) };
            Marshal.StructureToPtr(limits, lParam, false);
            return IntPtr.Zero;
        }
        if (message == _data.Callback)
        {
            var action = (uint)lParam.ToInt64();
            if (action is 0x0202 or 0x0203) _show();
            if (action == 0x0205)
            {
                var menu = CreatePopupMenu();
                try
                {
                    AppendMenu(menu, 0, 1, "打开 CurrentMusic"); AppendMenu(menu, 0, 2, "退出");
                    GetCursorPos(out var point); SetForegroundWindow(_window);
                    var selected = TrackPopupMenu(menu, 0x0100 | 0x0002, point.X, point.Y, 0, _window, IntPtr.Zero);
                    if (selected == 1) _show(); if (selected == 2) _exit();
                }
                finally { DestroyMenu(menu); }
            }
            return IntPtr.Zero;
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }
    public void Dispose() { ShellNotifyIcon(2, ref _data); RemoveWindowSubclass(_window, _callback, 1); }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size; public IntPtr Window; public uint Id, Flags, Callback; public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Version;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags; public Guid GuidItem; public IntPtr BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MinMaxInfo { public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    private delegate IntPtr SubclassProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, nuint id, nuint reference);
    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShellNotifyIcon(uint message, ref NotifyIconData data);
    [DllImport("comctl32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowSubclass(IntPtr window, SubclassProc callback, nuint id, nuint reference);
    [DllImport("comctl32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool RemoveWindowSubclass(IntPtr window, SubclassProc callback, nuint id);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "LoadIconW")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", EntryPoint = "AppendMenuW", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AppendMenu(IntPtr menu, uint flags, nuint id, string text);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr window, IntPtr rectangle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(IntPtr window);
}
