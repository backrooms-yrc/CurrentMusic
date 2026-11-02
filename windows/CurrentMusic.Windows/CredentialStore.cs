using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CurrentMusic.Core;

namespace CurrentMusic.Windows;

internal sealed record SavedSession(string Token, string Username);

// Win32 generic credentials work for unpackaged desktop apps without package identity.
internal static class CredentialStore
{
    private static string Target(string apiBase) => "CurrentMusic.Windows/" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(ClientSettings.ValidateApiBase(apiBase).AbsoluteUri)));
    public static void Save(string apiBase, SavedSession session)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(session);
        if (bytes.Length > 2560) throw new ArgumentException("会话数据超过 Windows 凭据容量。");
        var memory = Marshal.AllocCoTaskMem(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, memory, bytes.Length);
            var credential = new Credential { Type = 1, TargetName = Target(apiBase), CredentialBlobSize = (uint)bytes.Length, CredentialBlob = memory, Persist = 2, UserName = session.Username };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.Copy(new byte[bytes.Length], 0, memory, bytes.Length); Marshal.FreeCoTaskMem(memory); CryptographicOperations.ZeroMemory(bytes); }
    }
    public static SavedSession? Read(string apiBase)
    {
        if (!CredRead(Target(apiBase), 1, 0, out var pointer))
        {
            var code = Marshal.GetLastWin32Error();
            if (code == 1168) return null;
            throw new Win32Exception(code);
        }
        byte[]? bytes = null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlobSize > 2560) return null;
            bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return JsonSerializer.Deserialize<SavedSession>(bytes);
        }
        catch (JsonException) { Delete(apiBase); return null; }
        finally { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); CredFree(pointer); }
    }
    public static void Delete(string apiBase) => CredDelete(Target(apiBase), 1, 0);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string? UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr buffer);
}
