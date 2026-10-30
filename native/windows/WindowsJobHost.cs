// A fixed-recipe Windows Job host. Only the bounded official Desktop target is accepted.
// Availability of a recipe does not establish production launch qualification.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class WindowsJobHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint PROCESS_DUP_HANDLE = 0x00000040;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int ERROR_BROKEN_PIPE = 109;
    private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    private const uint PIPE_TYPE_MESSAGE = 0x00000004;
    private const uint PIPE_READMODE_MESSAGE = 0x00000002;
    private const uint PIPE_WAIT = 0;
    private const uint PIPE_NOWAIT = 0x00000001;
    private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
    private const uint GENERIC_READ = 0x80000000;
    private const uint OPEN_EXISTING = 3;
    private const uint DUPLICATE_SAME_ACCESS = 2;
    private const string DesktopExe = @"C:\Program Files\WindowsApps\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\app\resources\codex.exe";
    private const string DesktopVersion = "codex-cli 0.165.0-alpha.1.2\n";
    private static byte[] ReadBoundedVersion(Stream stream, int limit)
    {
        var output = new MemoryStream();
        var buffer = new byte[256];
        while (true)
        {
            int count = stream.Read(buffer, 0, buffer.Length);
            if (count == 0) return output.ToArray();
            if (output.Length + count > limit) throw new StageFailure("DESKTOP_TARGET");
            output.Write(buffer, 0, count);
        }
    }
    private static void CheckDesktopVersion(string target)
    {
        Process process = null;
        try
        {
            var start = new ProcessStartInfo(target, "--version");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            process = Process.Start(start);
            if (process == null) throw new StageFailure("DESKTOP_TARGET");
            Task<byte[]> stdout = Task.Factory.StartNew(() => ReadBoundedVersion(process.StandardOutput.BaseStream, 512),
                TaskCreationOptions.LongRunning);
            Task<byte[]> stderr = Task.Factory.StartNew(() => ReadBoundedVersion(process.StandardError.BaseStream, 4096),
                TaskCreationOptions.LongRunning);
            if (!process.WaitForExit(5000) || !Task.WaitAll(new Task[] { stdout, stderr }, 1000))
                throw new StageFailure("DESKTOP_TARGET");
            if (process.ExitCode != 0 ||
                !String.Equals(Encoding.UTF8.GetString(stdout.Result).Replace("\r\n", "\n"), DesktopVersion,
                    StringComparison.Ordinal)) throw new StageFailure("DESKTOP_TARGET");
        }
        catch { throw new StageFailure("DESKTOP_TARGET"); }
        finally
        {
            if (process != null)
            {
                try { if (!process.HasExited) { process.Kill(); process.WaitForExit(1000); } }
                catch { /* a failed or vanished version probe remains unavailable */ }
                process.Dispose();
            }
        }
    }
    private static string ValidateDesktopTarget(string target)
    {
        try
        {
            if (String.IsNullOrEmpty(target) || target.Length > 1024 || target.Length < 4 ||
                !Char.IsLetter(target[0]) || target[1] != ':' || target[2] != '\\' ||
                target.StartsWith(@"\\", StringComparison.Ordinal) ||
                !String.Equals(Path.GetFullPath(target), target, StringComparison.OrdinalIgnoreCase))
                throw new StageFailure("DESKTOP_TARGET");
            // LocalApplicationData can be redirected into an app sandbox. The installed
            // Desktop executable lives under the actual current user's profile.
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "AppData", "Local", "OpenAI", "Codex", "bin");
            bool legacy = String.Equals(target, DesktopExe, StringComparison.OrdinalIgnoreCase);
            bool local = false;
            if (target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                string relative = target.Substring(root.Length + 1);
                int separator = relative.IndexOf(Path.DirectorySeparatorChar);
                if (separator == 16 && relative.Length == separator + 1 + "codex.exe".Length &&
                    String.Equals(relative.Substring(separator + 1), "codex.exe", StringComparison.Ordinal))
                {
                    local = true;
                    for (int i = 0; i < separator; i++)
                        if (!((relative[i] >= '0' && relative[i] <= '9') ||
                              (relative[i] >= 'a' && relative[i] <= 'f'))) local = false;
                }
            }
            if (!legacy && !local) throw new StageFailure("DESKTOP_TARGET");
            SafeDirectory(Path.GetDirectoryName(target));
            var file = new FileInfo(target);
            if (!file.Exists || (file.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 ||
                file.Length == 0) throw new StageFailure("DESKTOP_TARGET");
            CheckDesktopVersion(target);
            return target;
        }
        catch { throw new StageFailure("DESKTOP_TARGET"); }
    }
    private static string ClaudeExe()
    {
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        SafeDirectory(profile);
        string exe = Path.Combine(profile, @".local\bin\claude.exe");
        SafeDirectory(Path.GetDirectoryName(exe));
        var info = new FileInfo(exe);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new StageFailure("PROCESS_CREATE");
        return exe;
    }
    // The trusted host selects this fixed current-user route before starting the helper.
    // Do not inherit any other provider or user-settings variables into the Claude child.
    private static string BuildClaudeModelEnvironment()
    {
        string[] names = {
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL"
        };
        string[] values = new string[names.Length];
        bool selected = false;
        for (int i = 0; i < names.Length; i++)
        {
            values[i] = Environment.GetEnvironmentVariable(names[i]);
            if (values[i] != null) selected = true;
            if (values[i] != null && (String.IsNullOrWhiteSpace(values[i]) ||
                values[i].IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                values[i].Length > (i == 0 ? 4096 : i == 1 ? 256 : 160)))
                throw new StageFailure("MODEL_CONFIG");
        }
        if (!selected) throw new StageFailure("MODEL_CONFIG");
        if (values[0] == null || values[1] == null ||
            !(String.Equals(values[1], "https://open.bigmodel.cn/api/anthropic", StringComparison.Ordinal) ||
              String.Equals(values[1], "https://open.bigmodel.cn/api/anthropic/", StringComparison.Ordinal)))
            throw new StageFailure("MODEL_CONFIG");
        var block = new StringBuilder();
        for (int i = 0; i < names.Length; i++)
            if (values[i] != null) block.Append(names[i]).Append('=').Append(values[i]).Append('\0');
        return block.ToString();
    }
    private const string Initialize = "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"repo-conduit-readiness\",\"version\":\"0.1.0\"},\"capabilities\":{\"experimentalApi\":true,\"requestAttestation\":false}}}\n";
    private const string Initialized = "{\"method\":\"initialized\"}\n";
    private const string Query = "{\"id\":2,\"method\":\"windowsSandbox/readiness\",\"params\":null}\n";
    private const string ConfigInitialize = "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"repo-conduit-config-check\",\"version\":\"0.1.0\"},\"capabilities\":{\"experimentalApi\":true,\"requestAttestation\":false}}}\n";
    private const string ConfigReadPrefix = "{\"id\":2,\"method\":\"config/read\",\"params\":{\"cwd\":\"";
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    { public uint nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public uint dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public IntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr output, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup,
        out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation,
        out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(IntPtr handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")]
    private static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode,
        uint maxInstances, uint outBufferSize, uint inBufferSize, uint timeout,
        ref SECURITY_ATTRIBUTES attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes,
        uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true,
        EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSecurityDescriptor(string sddl, uint revision,
        out IntPtr descriptor, out uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle,
        IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeInfo(IntPtr pipe, out uint flags, out uint outBuffer,
        out uint inBuffer, out uint maxInstances);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetNamedPipeHandleState(IntPtr pipe, ref uint mode,
        IntPtr maxCollectionCount, IntPtr collectDataTimeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeHandleState(IntPtr pipe, out uint mode,
        IntPtr currentInstances, IntPtr maxCollectionCount, IntPtr collectDataTimeout,
        IntPtr userName, uint maxUserNameSize);
    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();

    private sealed class StageFailure : Exception
    { public readonly string Code; public StageFailure(string code) { Code = code; } }
    private sealed class Members
    {
        public uint Assigned, Listed;
        public readonly List<uint> Pids = new List<uint>();
        public readonly List<uint> FixturePids = new List<uint>();
    }

    private static bool IsGuid(string value)
    {
        Guid parsed;
        return !String.IsNullOrEmpty(value) && Guid.TryParseExact(value, "D", out parsed) &&
            String.Equals(parsed.ToString("D"), value, StringComparison.Ordinal);
    }

    private static void Child(string role, string scenario, string host, string execution)
    {
        if (!IsGuid(host) || !IsGuid(execution) ||
            (scenario != "single" && scenario != "tree" && scenario != "parent_exits"))
            throw new StageFailure("ARGUMENTS");
        if (role == "__root")
        {
            if (scenario != "single") StartFixedChild("__child", scenario, host, execution);
            if (scenario == "parent_exits") { Thread.Sleep(1500); return; }
        }
        else if (role == "__child") StartFixedChild("__leaf", scenario, host, execution);
        else if (role != "__leaf") throw new StageFailure("ARGUMENTS");
        Thread.Sleep(60000);
    }

    private static void StartFixedChild(string role, string scenario, string host, string execution)
    {
        string exe = Assembly.GetExecutingAssembly().Location;
        var info = new ProcessStartInfo(exe, role + " " + scenario + " " + host + " " + execution);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.EnvironmentVariables.Clear();
        info.EnvironmentVariables.Add("SystemRoot", "C:\\Windows");
        info.EnvironmentVariables.Add("PATH", "C:\\Windows\\System32;C:\\Windows");
        Process child = Process.Start(info);
        if (child == null) throw new StageFailure("CHILD_START");
        child.Dispose();
    }

    private static Members ReadMembers(IntPtr job, int timeoutMs, string helperImage)
    {
        var watch = Stopwatch.StartNew();
        int capacity = 4;
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            int size = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                bool okay = QueryInformationJobObject(job, JobObjectBasicProcessIdList,
                    buffer, (uint)size, out returned);
                if (!okay || returned < 8 || returned > size)
                {
                    if (capacity < 1024) { capacity = Math.Min(capacity * 2, 1024); continue; }
                    Thread.Sleep(5); continue;
                }
                uint assigned = (uint)Marshal.ReadInt32(buffer, 0);
                uint listed = (uint)Marshal.ReadInt32(buffer, 4);
                if (assigned > 1024 || listed > assigned || listed > capacity)
                    throw new StageFailure("JOB_LIST_BOUNDS");
                if (8UL + (ulong)listed * (ulong)IntPtr.Size > returned)
                    throw new StageFailure("JOB_LIST_TRUNCATED");
                if (listed != assigned)
                {
                    capacity = Math.Min(1024, Math.Max(capacity * 2, (int)assigned));
                    Thread.Sleep(5); continue;
                }
                var result = new Members { Assigned = assigned, Listed = listed };
                for (int i = 0; i < listed; ++i)
                {
                    long pid = IntPtr.Size == 8 ? Marshal.ReadInt64(buffer, 8 + i * IntPtr.Size) :
                        Marshal.ReadInt32(buffer, 8 + i * IntPtr.Size);
                    if (pid <= 0 || (ulong)pid > UInt32.MaxValue) throw new StageFailure("JOB_LIST_PID");
                    result.Pids.Add((uint)pid);
                }
                var unique = new HashSet<uint>(result.Pids);
                if (unique.Count != result.Pids.Count) throw new StageFailure("JOB_LIST_DUPLICATE");
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = ReadAccounting(job);
                if (accounting.ActiveProcesses != listed) { Thread.Sleep(5); continue; }
                bool retry = false;
                foreach (uint pid in result.Pids)
                {
                    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
                    if (process == IntPtr.Zero) { retry = true; break; }
                    try
                    {
                        bool inJob;
                        var image = new StringBuilder(32768);
                        uint length = (uint)image.Capacity;
                        FILETIME creation, exit, kernel, user;
                        uint wait = WaitForSingleObject(process, 0);
                        if (wait != WAIT_TIMEOUT || !IsProcessInJob(process, job, out inJob) || !inJob ||
                            !QueryFullProcessImageName(process, 0, image, ref length) || length == 0 ||
                            !GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
                            (((ulong)creation.High << 32) | creation.Low) == 0)
                        { retry = true; break; }
                        if (String.Equals(image.ToString(), helperImage, StringComparison.OrdinalIgnoreCase))
                            result.FixturePids.Add(pid);
                    }
                    finally { CloseHandle(process); }
                }
                if (retry) { Thread.Sleep(5); continue; }
                result.FixturePids.Sort();
                return result;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new StageFailure("JOB_LIST_INCOMPLETE");
    }

    private static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION ReadAccounting(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                buffer, (uint)size, out returned) || returned < size)
                throw new StageFailure("JOB_ACCOUNTING");
            return (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer,
                typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string Bool(bool value) { return value ? "true" : "false"; }
    private static bool RootExited(IntPtr root)
    {
        uint wait = WaitForSingleObject(root, 0);
        if (wait == WAIT_OBJECT_0) return true;
        if (wait == WAIT_TIMEOUT) return false;
        throw new StageFailure("ROOT_WAIT");
    }
    private static void WriteObservation(string scenario, string host, string execution,
        int sequence, string phase, uint pid, ulong creation, bool rootExited,
        Members members, bool stopRequested, bool stopSucceeded)
    {
        var text = new StringBuilder();
        text.Append("{\"protocol\":\"windows_job_canary_observation_v1\",\"helperVersion\":\"2\",\"scenario\":\"");
        text.Append(scenario).Append("\",\"hostScopeId\":\"").Append(host);
        text.Append("\",\"executionInstanceId\":\"").Append(execution);
        text.Append("\",\"sequence\":").Append(sequence.ToString(Invariant));
        text.Append(",\"phase\":\"").Append(phase).Append("\",\"root\":{\"pid\":");
        text.Append(pid.ToString(Invariant)).Append(",\"creationFiletime\":\"");
        text.Append(creation.ToString(Invariant)).Append("\"},\"createdSuspended\":true");
        text.Append(",\"jobMemberBeforeResume\":true,\"resumed\":true,\"rootExited\":");
        text.Append(Bool(rootExited)).Append(",\"members\":{\"complete\":true,\"assigned\":");
        text.Append(members.Assigned.ToString(Invariant)).Append(",\"listed\":");
        text.Append(members.Listed.ToString(Invariant)).Append(",\"pids\":[");
        for (int i = 0; i < members.Pids.Count; ++i)
        { if (i != 0) text.Append(','); text.Append(members.Pids[i].ToString(Invariant)); }
        text.Append("],\"fixturePids\":[");
        for (int i = 0; i < members.FixturePids.Count; ++i)
        { if (i != 0) text.Append(','); text.Append(members.FixturePids[i].ToString(Invariant)); }
        text.Append("]},\"stopRequested\":").Append(Bool(stopRequested));
        text.Append(",\"stopCallSucceeded\":").Append(Bool(stopSucceeded)).Append('}');
        Console.Out.WriteLine(text.ToString());
        Console.Out.Flush();
    }

    private static int Host(string scenario, string host, string execution)
    {
        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr root = IntPtr.Zero, thread = IntPtr.Zero;
        bool listInitialized = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new StageFailure("JOB_CREATE");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new StageFailure("JOB_LIMIT");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw new StageFailure("ATTRIBUTE_SIZE");
            list = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw new StageFailure("ATTRIBUTE_INIT");
            listInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new StageFailure("ATTRIBUTE_JOB");
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = list;
            string exe = Assembly.GetExecutingAssembly().Location;
            var command = new StringBuilder("\"" + exe + "\" __root " + scenario + " " + host + " " + execution);
            environment = Marshal.StringToHGlobalUni("SystemRoot=C:\\Windows\0PATH=C:\\Windows\\System32;C:\\Windows\0");
            PROCESS_INFORMATION process;
            if (!CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT |
                CREATE_UNICODE_ENVIRONMENT, environment, null, ref startup, out process))
                throw new StageFailure("PROCESS_CREATE");
            root = process.hProcess; thread = process.hThread;
            bool member;
            if (!IsProcessInJob(root, job, out member) || !member)
                throw new StageFailure("PRE_RESUME_MEMBERSHIP");
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(root, out creation, out exit, out kernel, out user))
                throw new StageFailure("PROCESS_IDENTITY");
            ulong filetime = ((ulong)creation.High << 32) | creation.Low;
            if (filetime == 0 || process.dwProcessId == 0)
                throw new StageFailure("PROCESS_IDENTITY");
            if (ResumeThread(thread) == UInt32.MaxValue)
                throw new StageFailure("PROCESS_RESUME");
            CloseHandle(thread); thread = IntPtr.Zero;
            int expected = scenario == "single" ? 1 : 3;
            Members initial = null;
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 5000)
            {
                initial = ReadMembers(job, 500, exe);
                if (initial.FixturePids.Count >= expected &&
                    initial.FixturePids.Contains(process.dwProcessId)) break;
                Thread.Sleep(10);
            }
            if (initial == null || initial.FixturePids.Count < expected ||
                !initial.FixturePids.Contains(process.dwProcessId))
                throw new StageFailure("TREE_NOT_STABLE");
            int sequence = 1;
            WriteObservation(scenario, host, execution, sequence, "running",
                process.dwProcessId, filetime, RootExited(root),
                initial, false, false);
            var lifetime = Stopwatch.StartNew();
            while (lifetime.ElapsedMilliseconds < 60000)
            {
                int remaining = (int)Math.Max(1, 60000 - lifetime.ElapsedMilliseconds);
                Task<string> input = Task.Factory.StartNew(() => Console.In.ReadLine(),
                    TaskCreationOptions.LongRunning);
                if (!input.Wait(remaining)) throw new StageFailure("INPUT_TIMEOUT");
                string commandLine = input.Result;
                if (commandLine == "observe")
                {
                    Members members = ReadMembers(job, 1000, exe);
                    WriteObservation(scenario, host, execution, ++sequence, "running",
                        process.dwProcessId, filetime, RootExited(root),
                        members, false, false);
                }
                else if (commandLine == "stop")
                {
                    if (!TerminateJobObject(job, 0)) throw new StageFailure("JOB_TERMINATE");
                    var stopped = Stopwatch.StartNew();
                    while (stopped.ElapsedMilliseconds < 5000)
                    {
                        uint wait = WaitForSingleObject(root, 0);
                        if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT)
                            throw new StageFailure("ROOT_WAIT");
                        Members members = ReadMembers(job, 500, exe);
                        if (wait == WAIT_OBJECT_0 && members.Assigned == 0 && members.Listed == 0)
                        {
                            WriteObservation(scenario, host, execution, ++sequence, "closed",
                                process.dwProcessId, filetime, true, members, true, true);
                            return 0;
                        }
                        Thread.Sleep(10);
                    }
                    throw new StageFailure("JOB_NOT_EMPTY");
                }
                else throw new StageFailure(commandLine == null ? "INPUT_EOF" : "INPUT_UNKNOWN");
            }
            throw new StageFailure("INPUT_TIMEOUT");
        }
        catch (StageFailure failure) { Console.Error.WriteLine(failure.Code); return 1; }
        catch { Console.Error.WriteLine("HOST_UNKNOWN"); return 1; }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (root != IntPtr.Zero) CloseHandle(root);
            if (listInitialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (job != IntPtr.Zero) CloseHandle(job); // KILL_ON_JOB_CLOSE covers every descendant.
        }
    }

    private sealed class StdioState
    {
        public readonly object Gate = new object();
        public readonly string Recipe, Host, Execution;
        public int Sequence, StdoutBytes, StderrBytes;
        public bool StdoutEof, StderrEof, RootExitSent;
        public volatile bool Fault;
        public StdioState(string recipe, string host, string execution)
        { Recipe = recipe; Host = host; Execution = execution; }
        private string Begin(string kind)
        {
            return "{\"protocol\":\"windows_job_stdio_v1\",\"helperVersion\":\"3\",\"recipe\":\"" +
                Recipe + "\",\"hostScopeId\":\"" + Host + "\",\"executionInstanceId\":\"" +
                Execution + "\",\"sequence\":" + (++Sequence).ToString(Invariant) +
                ",\"kind\":\"" + kind + "\"";
        }
        private void Write(string frame)
        { Console.Out.WriteLine(frame + "}"); Console.Out.Flush(); }
        public void Started(uint pid, ulong creation, string writer = null)
        {
            lock (Gate) Write(Begin("started") + ",\"root\":{\"pid\":" + pid.ToString(Invariant) +
                ",\"creationFiletime\":\"" + creation.ToString(Invariant) +
                "\"},\"createdSuspended\":true,\"jobMemberBeforeResume\":true" +
                (writer == null ? "" : ",\"writer\":" + writer));
        }
        public void Prepared(string writer)
        {
            lock (Gate) Write(Begin("prepared") + ",\"childPresent\":false,\"writer\":" + writer);
        }
        public void PreparedClosed()
        {
            lock (Gate) Write(Begin("prepared_closed") +
                ",\"childPresent\":false,\"members\":{\"complete\":true,\"assigned\":0,\"listed\":0,\"pids\":[]}");
        }
        public void Data(string kind, byte[] buffer, int count)
        {
            lock (Gate)
            {
                if (Fault) return;
                if (kind == "stdout") StdoutBytes += count; else StderrBytes += count;
                bool prepared = Recipe == "prepared_owned_fixture_v1" ||
                    Recipe == "windows_app_server_readonly_v1" ||
                    Recipe == "windows_claude_readonly_v1";
                if (count < 1 || count > 4096 || (prepared ?
                    StdoutBytes + StderrBytes > 1024 * 1024 :
                    StdoutBytes > 65536 || StderrBytes > 65536 ||
                    StdoutBytes + StderrBytes > 131072)) { Fault = true; return; }
                var copied = new byte[count]; Array.Copy(buffer, copied, count);
                Write(Begin(kind) + ",\"dataBase64\":\"" + Convert.ToBase64String(copied) + "\"");
            }
        }
        public void Eof(string kind)
        {
            lock (Gate)
            {
                if (kind == "stdout_eof") StdoutEof = true; else StderrEof = true;
                if (!Fault) Write(Begin(kind));
            }
        }
        public void RootExit()
        {
            lock (Gate)
            {
                if (RootExitSent || Fault) return;
                RootExitSent = true; Write(Begin("root_exit"));
            }
        }
        public void Closed(uint pid, ulong creation)
        {
            lock (Gate) Write(Begin("job_closed") + ",\"root\":{\"pid\":" +
                pid.ToString(Invariant) + ",\"creationFiletime\":\"" +
                creation.ToString(Invariant) + "\"},\"rootExited\":true,\"members\":{\"complete\":true,\"assigned\":0,\"listed\":0,\"pids\":[]}");
        }
    }

    private static void ReadPipe(IntPtr handle, string kind, StdioState state)
    {
        var bytes = new byte[4096];
        while (true)
        {
            uint count;
            bool okay = ReadFile(handle, bytes, (uint)bytes.Length, out count, IntPtr.Zero);
            if (!okay)
            {
                if (Marshal.GetLastWin32Error() == ERROR_BROKEN_PIPE) state.Eof(kind + "_eof");
                else { lock (state.Gate) state.Fault = true; }
                return;
            }
            if (count == 0) { state.Eof(kind + "_eof"); return; }
            state.Data(kind, bytes, (int)count);
            if (state.Fault) return;
        }
    }

    private static void WriteInput(IntPtr handle, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        int offset = 0;
        while (offset < bytes.Length)
        {
            byte[] remaining = new byte[bytes.Length - offset];
            Array.Copy(bytes, offset, remaining, 0, remaining.Length);
            uint written;
            if (!WriteFile(handle, remaining, (uint)remaining.Length, out written, IntPtr.Zero) ||
                written == 0 || written > remaining.Length) throw new StageFailure("STDIN_WRITE");
            offset += (int)written;
        }
    }

    private static string OwnedPipeName(string host, string execution)
    { return @"\\.\pipe\RepoConduit-owned-" + host + "-" + execution; }
    private static string PreparedPipeName(string host, string execution)
    { return @"\\.\pipe\RepoConduit-prepared-" + host + "-" + execution; }

    private static void CreateOwnedInput(string host, string execution, bool prepared,
        out IntPtr childInput, out IntPtr parentInput)
    {
        childInput = IntPtr.Zero; parentInput = IntPtr.Zero;
        string name = prepared ? PreparedPipeName(host, execution) : OwnedPipeName(host, execution);
        string sid = WindowsIdentity.GetCurrent().User.Value;
        IntPtr descriptor;
        uint descriptorLength;
        if (!ConvertSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1,
            out descriptor, out descriptorLength)) throw new StageFailure("PIPE_DACL");
        try
        {
            var serverAttributes = new SECURITY_ATTRIBUTES();
            serverAttributes.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            serverAttributes.lpSecurityDescriptor = descriptor;
            serverAttributes.bInheritHandle = false;
            parentInput = CreateNamedPipe(name,
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, prepared ? 131072u : 8192u, 0, 0, ref serverAttributes);
            if (parentInput == new IntPtr(-1)) { parentInput = IntPtr.Zero; throw new StageFailure("PIPE_CREATE"); }
            var clientAttributes = new SECURITY_ATTRIBUTES();
            clientAttributes.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            clientAttributes.bInheritHandle = true;
            childInput = CreateFile(name, GENERIC_READ, 0,
                ref clientAttributes, OPEN_EXISTING, 0, IntPtr.Zero);
            if (childInput == new IntPtr(-1)) { childInput = IntPtr.Zero; throw new StageFailure("PIPE_CONNECT"); }
        }
        finally { LocalFree(descriptor); }
    }

    private static bool ExactDecimal(string value, out ulong number)
    {
        number = 0;
        if (String.IsNullOrEmpty(value) || value.Length > 20 || value[0] == '0') return false;
        foreach (char ch in value) if (ch < '0' || ch > '9') return false;
        return UInt64.TryParse(value, NumberStyles.None, Invariant, out number);
    }

    private static bool SafeJsonValue(object value, int depth)
    {
        if (depth > 64) return false;
        IDictionary dictionary = value as IDictionary;
        if (dictionary != null)
        {
            foreach (DictionaryEntry entry in dictionary)
                if (!(entry.Key is string) || (string)entry.Key == "__type" ||
                    !SafeJsonValue(entry.Value, depth + 1)) return false;
            return true;
        }
        IEnumerable sequence = value as IEnumerable;
        if (sequence != null && !(value is string))
        {
            foreach (object item in sequence) if (!SafeJsonValue(item, depth + 1)) return false;
        }
        return true;
    }

    private static string ReadOwnedFrame(bool arbitrary)
    {
        var bytes = new byte[arbitrary ? 65536 : 256];
        int used = 0;
        Stream input = Console.OpenStandardInput();
        while (used <= bytes.Length)
        {
            int value = input.ReadByte();
            if (value < 0) break;
            if (used == bytes.Length) throw new StageFailure("WRITER_FRAME_LIMIT");
            bytes[used++] = (byte)value;
        }
        string frame = new UTF8Encoding(false, true).GetString(bytes, 0, used);
        if (arbitrary)
        {
            if (used < 3 || frame[0] != '{' || frame[frame.Length - 2] != '}' ||
                frame[frame.Length - 1] != '\n' || frame.IndexOf('\n') != frame.Length - 1 ||
                frame.IndexOf('\r') >= 0 || frame.IndexOf('\0') >= 0)
                throw new StageFailure("WRITER_FRAME");
            try
            {
                Type parserType = Type.GetType("System.Web.Script.Serialization.JavaScriptSerializer, " +
                    "System.Web.Extensions, Version=4.0.0.0, Culture=neutral, " +
                    "PublicKeyToken=31bf3856ad364e35", true);
                object parser = Activator.CreateInstance(parserType);
                parserType.GetProperty("MaxJsonLength").SetValue(parser, 65536, null);
                parserType.GetProperty("RecursionLimit").SetValue(parser, 64, null);
                object parsed = parserType.GetMethod("DeserializeObject").Invoke(parser,
                    new object[] { frame.Substring(0, frame.Length - 1) });
                if (!(parsed is IDictionary) || !SafeJsonValue(parsed, 0))
                    throw new StageFailure("WRITER_FRAME");
            }
            catch { throw new StageFailure("WRITER_FRAME"); }
            return frame;
        }
        if (frame == "owned-initialize\n") return Initialize;
        if (frame == "owned-initialized\n") return Initialized;
        if (frame == "owned-query\n") return Query;
        throw new StageFailure("WRITER_FRAME");
    }

    private static bool WriterDeadline(long utcTicks, ulong uptimeMs)
    { return DateTime.UtcNow.Ticks < utcTicks && GetTickCount64() < uptimeMs; }

    private static int WriteOwnedPipe(string[] args, bool arbitrary)
    {
        IntPtr process = IntPtr.Zero, pipe = IntPtr.Zero;
        try
        {
            if (args.Length != 9 || !IsGuid(args[1]) || !IsGuid(args[2]) ||
                args[5] != (arbitrary ? PreparedPipeName(args[1], args[2]) :
                    OwnedPipeName(args[1], args[2]))) throw new StageFailure("WRITER_ORIGIN");
            ulong pid, filetime, handle, deadlineUtc, deadlineUptime;
            if (!ExactDecimal(args[3], out pid) || pid > UInt32.MaxValue ||
                !ExactDecimal(args[4], out filetime) || !ExactDecimal(args[6], out handle) ||
                !ExactDecimal(args[7], out deadlineUtc) || deadlineUtc > Int64.MaxValue ||
                !ExactDecimal(args[8], out deadlineUptime)) throw new StageFailure("WRITER_ORIGIN");
            string frame = ReadOwnedFrame(arbitrary);
            if (!WriterDeadline((long)deadlineUtc, deadlineUptime)) throw new StageFailure("WRITER_DEADLINE");
            process = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                false, (uint)pid);
            if (process == IntPtr.Zero || WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                throw new StageFailure("WRITER_PROCESS");
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
                (((ulong)creation.High << 32) | creation.Low) != filetime)
                throw new StageFailure("WRITER_PROCESS");
            var image = new StringBuilder(32768);
            uint length = (uint)image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref length) ||
                !String.Equals(image.ToString(), Assembly.GetExecutingAssembly().Location,
                    StringComparison.OrdinalIgnoreCase)) throw new StageFailure("WRITER_IMAGE");
            if (!DuplicateHandle(process, new IntPtr(unchecked((long)handle)), GetCurrentProcess(),
                out pipe, 0, false, DUPLICATE_SAME_ACCESS) || pipe == IntPtr.Zero)
                throw new StageFailure("WRITER_HANDLE");
            if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
                !GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
                (((ulong)creation.High << 32) | creation.Low) != filetime)
                throw new StageFailure("WRITER_PROCESS");
            uint serverPid, flags, outBuffer, inBuffer, instances, mode;
            if (!GetNamedPipeServerProcessId(pipe, out serverPid) || serverPid != (uint)pid)
                throw new StageFailure("WRITER_PIPE_SERVER");
            if (!GetNamedPipeInfo(pipe, out flags, out outBuffer, out inBuffer, out instances) ||
                (flags & (1u | PIPE_TYPE_MESSAGE)) != (1u | PIPE_TYPE_MESSAGE))
                throw new StageFailure("WRITER_PIPE_TYPE");
            if (!GetNamedPipeHandleState(pipe, out mode, IntPtr.Zero, IntPtr.Zero,
                    IntPtr.Zero, IntPtr.Zero, 0) || (mode & PIPE_NOWAIT) == 0)
                throw new StageFailure("WRITER_PIPE_MODE");
            // The fixed helper creates one first-instance named pipe and retains this original
            // server HANDLE for its entire lifetime. DuplicateHandle preserves that object.
            if (!WriterDeadline((long)deadlineUtc, deadlineUptime)) throw new StageFailure("WRITER_DEADLINE");
            byte[] payload = Encoding.UTF8.GetBytes(frame);
            uint written;
            bool okay = WriteFile(pipe, payload, (uint)payload.Length, out written, IntPtr.Zero);
            if (!okay || written != payload.Length) throw new StageFailure("WRITER_UNKNOWN");
            Console.Out.Write("{\"accepted\":true}");
            return 0;
        }
        catch (StageFailure failure) { Console.Error.WriteLine(failure.Code); return 1; }
        catch { Console.Error.WriteLine("WRITER_UNKNOWN"); return 1; }
        finally
        {
            if (pipe != IntPtr.Zero) CloseHandle(pipe);
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }

    private static string ReadControlLine()
    {
        var line = new StringBuilder();
        for (int i = 0; i < 64; ++i)
        {
            int ch = Console.In.Read();
            if (ch < 0) return null;
            if (ch == '\n') return line.ToString();
            if (ch < 32 || ch > 126) throw new StageFailure("CONTROL_INVALID");
            line.Append((char)ch);
        }
        throw new StageFailure("CONTROL_LIMIT");
    }

    private static string AwaitControl(StdioState state, Stopwatch lifetime, int maxMs = 60000)
    {
        Task<string> pending = Task.Factory.StartNew(() => ReadControlLine(),
            TaskCreationOptions.LongRunning);
        while (lifetime.ElapsedMilliseconds < maxMs)
        {
            if (state.Fault) throw new StageFailure("PIPE_LIMIT");
            if (pending.Wait(100)) return pending.Result;
        }
        throw new StageFailure("CONTROL_TIMEOUT");
    }

    private static string JsonString(string value)
    { return value.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    private static string WriterIdentity(string host, string execution, IntPtr parentInput,
        int wallSeconds, bool prepared, long deadlineUtcTicks = 0, ulong deadlineUptimeMs = 0)
    {
        FILETIME helperCreation, helperExit, helperKernel, helperUser;
        if (!GetProcessTimes(GetCurrentProcess(), out helperCreation, out helperExit,
            out helperKernel, out helperUser)) throw new StageFailure("HELPER_IDENTITY");
        ulong helperFiletime = ((ulong)helperCreation.High << 32) | helperCreation.Low;
        ulong handleValue = unchecked((ulong)parentInput.ToInt64());
        if (helperFiletime == 0 || handleValue == 0) throw new StageFailure("HELPER_IDENTITY");
        if (deadlineUtcTicks == 0) deadlineUtcTicks = DateTime.UtcNow.AddSeconds(wallSeconds).Ticks;
        if (deadlineUptimeMs == 0) deadlineUptimeMs = GetTickCount64() + (ulong)wallSeconds * 1000;
        return "{\"helperPid\":" + Process.GetCurrentProcess().Id.ToString(Invariant) +
            ",\"helperCreationFiletime\":\"" + helperFiletime.ToString(Invariant) +
            "\",\"pipeName\":\"" + JsonString(prepared ? PreparedPipeName(host, execution) :
                OwnedPipeName(host, execution)) +
            "\",\"handle\":\"" + handleValue.ToString(Invariant) +
            "\",\"deadlineUtcTicks\":\"" + deadlineUtcTicks.ToString(Invariant) +
            "\",\"deadlineUptimeMs\":\"" + deadlineUptimeMs.ToString(Invariant) + "\"}";
    }

    private static void SafeDirectory(string path)
    {
        if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) ||
            !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new StageFailure("CONFIG_PATH");
        for (DirectoryInfo info = new DirectoryInfo(path); info != null; info = info.Parent)
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new StageFailure("CONFIG_PATH");
    }

    private static FileStream OpenConfig(string runtimeRoot, string expectedSha)
    {
        if (String.IsNullOrEmpty(expectedSha) || expectedSha.Length != 64)
            throw new StageFailure("CONFIG_HASH");
        for (int i = 0; i < expectedSha.Length; ++i)
            if (!((expectedSha[i] >= '0' && expectedSha[i] <= '9') ||
                  (expectedSha[i] >= 'a' && expectedSha[i] <= 'f')))
                throw new StageFailure("CONFIG_HASH");
        SafeDirectory(runtimeRoot);
        foreach (string relative in new[] { "home", @"home\.codex", "AppDataLocal",
            "AppDataRoaming", "temp", "check" }) SafeDirectory(Path.Combine(runtimeRoot, relative));
        if (Directory.GetFileSystemEntries(Path.Combine(runtimeRoot, "check")).Length != 0)
            throw new StageFailure("CONFIG_PATH");
        string file = Path.Combine(runtimeRoot, @"home\.codex\config.toml");
        var info = new FileInfo(file);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > 65536)
            throw new StageFailure("CONFIG_FILE");
        var held = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            using (var sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(held)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actual, expectedSha, StringComparison.Ordinal))
                    throw new StageFailure("CONFIG_HASH");
            }
            held.Position = 0;
            return held;
        }
        catch { held.Dispose(); throw; }
    }

    private static FileStream OpenClaudeConfig(string runtimeRoot, string expectedSha,
        string ownerSourceCwd)
    {
        if (String.IsNullOrEmpty(expectedSha) || expectedSha.Length != 64)
            throw new StageFailure("CONFIG_HASH");
        for (int i = 0; i < expectedSha.Length; ++i)
            if (!((expectedSha[i] >= '0' && expectedSha[i] <= '9') ||
                  (expectedSha[i] >= 'a' && expectedSha[i] <= 'f')))
                throw new StageFailure("CONFIG_HASH");
        SafeDirectory(runtimeRoot);
        SafeDirectory(ownerSourceCwd);
        if (!String.Equals(ownerSourceCwd, Path.Combine(runtimeRoot, "work"),
            StringComparison.OrdinalIgnoreCase) ||
            Directory.GetFileSystemEntries(ownerSourceCwd).Length != 0)
            throw new StageFailure("CONFIG_PATH");
        string file = Path.Combine(runtimeRoot, "mcp.json");
        var info = new FileInfo(file);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 ||
            info.Length < 2 || info.Length > 65536)
            throw new StageFailure("CONFIG_FILE");
        var held = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            using (var sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(held)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actual, expectedSha, StringComparison.Ordinal))
                    throw new StageFailure("CONFIG_HASH");
            }
            held.Position = 0;
            return held;
        }
        catch { held.Dispose(); throw; }
    }

    private static void StdioFixture()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        var output = Console.OpenStandardOutput();
        var error = Console.OpenStandardError();
        byte[] diagnostic = Encoding.UTF8.GetBytes("fixture π stderr\n");
        error.Write(diagnostic, 0, diagnostic.Length); error.Flush();
        if (input.ReadLine() != Initialize.TrimEnd('\n')) return;
        byte[] first = Encoding.UTF8.GetBytes("{\"id\":1,\"result\":{\"userAgent\":\"fixture π\",\"codexHome\":\"C:\\\\fixture\",\"platformFamily\":\"windows\",\"platformOs\":\"windows\"}}\n");
        int split = Array.IndexOf(first, Encoding.UTF8.GetBytes("π")[0]) + 1;
        if (split < 2 || split >= first.Length) throw new StageFailure("FIXTURE_UTF8");
        output.Write(first, 0, split); output.Flush(); Thread.Sleep(10);
        output.Write(first, split, first.Length - split); output.Flush();
        if (input.ReadLine() != Initialized.TrimEnd('\n')) return;
        if (input.ReadLine() != Query.TrimEnd('\n')) return;
        byte[] answer = Encoding.UTF8.GetBytes("{\"id\":2,\"result\":{\"status\":\"notConfigured\"}}\n");
        output.Write(answer, 0, answer.Length); output.Flush();
        while (input.Read() >= 0) { /* wait for explicit stdin-close */ }
    }

    private static void PreparedFixture()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        string line = input.ReadLine();
        if (line == null) return;
        byte[] frame = Encoding.UTF8.GetBytes(line + "\n");
        if (frame.Length > 65536) throw new StageFailure("FIXTURE_FRAME");
        string digest;
        using (var sha = SHA256.Create())
            digest = BitConverter.ToString(sha.ComputeHash(frame)).Replace("-", "").ToLowerInvariant();
        Console.Out.WriteLine("{\"receivedBytes\":" + frame.Length.ToString(Invariant) +
            ",\"sha256\":\"" + digest + "\"}");
        Console.Out.Flush();
        while (input.Read() >= 0) { /* wait for Job stop */ }
    }

    private static int StdioHost(string recipe, string host, string execution,
        string runtimeRoot = null, string configSha = null, string ownerSourceCwd = null,
        int wallSeconds = 60, int claudeMaxTurns = 1, string desktopTarget = null)
    {
        bool ownedFixture = recipe == "owned_pipe_fixture_v1";
        bool preparedFixture = recipe == "prepared_owned_fixture_v1";
        bool productionPrepared = recipe == "windows_app_server_readonly_v1";
        bool claudePrepared = recipe == "windows_claude_readonly_v1";
        bool prepared = preparedFixture || productionPrepared || claudePrepared;
        bool ownedPipe = ownedFixture || prepared;
        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobList = IntPtr.Zero,
            handles = IntPtr.Zero, environment = IntPtr.Zero, root = IntPtr.Zero, thread = IntPtr.Zero;
        IntPtr childInput = IntPtr.Zero, parentInput = IntPtr.Zero,
            parentOutput = IntPtr.Zero, childOutput = IntPtr.Zero,
            parentError = IntPtr.Zero, childError = IntPtr.Zero;
        bool listInitialized = false;
        FileStream heldConfig = null;
        var state = new StdioState(recipe, host, execution);
        try
        {
            bool configCheck = recipe == "desktop_config_check_v1";
            bool desktopRecipe = recipe == "desktop_readiness_v1" || configCheck || productionPrepared;
            string desktopExe = desktopRecipe ? ValidateDesktopTarget(desktopTarget) : null;
            if (configCheck || productionPrepared) heldConfig = OpenConfig(runtimeRoot, configSha);
            if (productionPrepared) SafeDirectory(ownerSourceCwd);
            if (claudePrepared) heldConfig = OpenClaudeConfig(runtimeRoot, configSha, ownerSourceCwd);
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new StageFailure("JOB_CREATE");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new StageFailure("JOB_LIMIT");
            var security = new SECURITY_ATTRIBUTES();
            security.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = true;
            if (ownedPipe) CreateOwnedInput(host, execution, prepared, out childInput, out parentInput);
            else if (!CreatePipe(out childInput, out parentInput, ref security, 0))
                throw new StageFailure("PIPE_CREATE");
            if (!CreatePipe(out parentOutput, out childOutput, ref security, 0) ||
                !CreatePipe(out parentError, out childError, ref security, 0))
                throw new StageFailure("PIPE_CREATE");
            if (!SetHandleInformation(parentInput, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(parentOutput, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(parentError, HANDLE_FLAG_INHERIT, 0))
                throw new StageFailure("PIPE_INHERIT");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw new StageFailure("ATTRIBUTE_SIZE");
            list = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(list, 2, 0, ref size))
                throw new StageFailure("ATTRIBUTE_INIT");
            listInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new StageFailure("ATTRIBUTE_JOB");
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, childInput);
            Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, childError);
            if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new StageFailure("ATTRIBUTE_HANDLES");
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childInput;
            startup.StartupInfo.hStdOutput = childOutput;
            startup.StartupInfo.hStdError = childError;
            startup.lpAttributeList = list;
            var lifetime = Stopwatch.StartNew();
            long preparedUtcTicks = 0;
            ulong preparedUptimeMs = 0;
            if (prepared)
            {
                preparedUtcTicks = DateTime.UtcNow.AddSeconds(wallSeconds).Ticks;
                preparedUptimeMs = GetTickCount64() + (ulong)wallSeconds * 1000;
                state.Prepared(WriterIdentity(host, execution, parentInput, wallSeconds, true,
                    preparedUtcTicks, preparedUptimeMs));
                string firstControl = AwaitControl(state, lifetime, wallSeconds * 1000);
                if (firstControl == "stop")
                {
                    Members empty = ReadMembers(job, 500, Assembly.GetExecutingAssembly().Location);
                    if (empty.Assigned != 0 || empty.Listed != 0) throw new StageFailure("JOB_NOT_EMPTY");
                    state.PreparedClosed(); return 0;
                }
                if (firstControl != "start") throw new StageFailure("CONTROL_ORDER");
                if (lifetime.ElapsedMilliseconds >= wallSeconds * 1000 ||
                    !WriterDeadline(preparedUtcTicks, preparedUptimeMs))
                    throw new StageFailure("PREPARED_DEADLINE");
            }
            if (claudePrepared && Directory.GetFileSystemEntries(ownerSourceCwd).Length != 0)
                throw new StageFailure("CONFIG_PATH");
            if (desktopRecipe) desktopExe = ValidateDesktopTarget(desktopTarget);
            string exe = recipe == "stdio_fixture_v1" || ownedFixture || preparedFixture ?
                Assembly.GetExecutingAssembly().Location : claudePrepared ? ClaudeExe() : desktopExe;
            string arguments = recipe == "stdio_fixture_v1" || ownedFixture ?
                "__stdio_fixture " + host + " " + execution :
                preparedFixture ? "__prepared_fixture " + host + " " + execution :
                claudePrepared ? "--print --verbose --output-format stream-json " +
                    "--input-format stream-json --no-session-persistence --tools \"\" " +
                    "--restricted --setting-sources \"\" --strict-mcp-config " +
                    "--mcp-config \"" + Path.Combine(runtimeRoot, "mcp.json") +
                    "\" --disable-slash-commands --permission-mode dontAsk " +
                    "--permission-prompts none " +
                    "--settings \"{\\\"disableAllHooks\\\":true}\" " +
                    "--max-turns " + claudeMaxTurns.ToString(Invariant) +
                    " --allowedTools mcp__repo-conduit__repo.read,mcp__repo-conduit__repo_read" :
                (configCheck || productionPrepared) ? "app-server --stdio --strict-config" : "app-server --stdio";
            var command = new StringBuilder("\"" + exe + "\" " + arguments);
            string environmentText = "SystemRoot=C:\\Windows\0PATH=C:\\Windows\\System32;C:\\Windows\0";
            if (claudePrepared)
            {
                string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                environmentText += "USERPROFILE=" + profile + "\0" +
                    "APPDATA=" + Path.Combine(profile, @"AppData\Roaming") + "\0" +
                    "LOCALAPPDATA=" + Path.Combine(profile, @"AppData\Local") + "\0" +
                    "TEMP=" + Path.Combine(profile, @"AppData\Local\Temp") + "\0" +
                    "TMP=" + Path.Combine(profile, @"AppData\Local\Temp") + "\0" +
                    "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1\0" +
                    "NO_PROXY=127.0.0.1,localhost\0";
                string proxy = Environment.GetEnvironmentVariable("HTTPS_PROXY");
                if (!String.IsNullOrEmpty(proxy) &&
                    System.Text.RegularExpressions.Regex.IsMatch(proxy,
                        @"^http://(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}/?$"))
                    environmentText += "HTTPS_PROXY=" + proxy + "\0HTTP_PROXY=" + proxy + "\0";
                environmentText += BuildClaudeModelEnvironment();
            }
            if (configCheck || productionPrepared)
            {
                string home = Path.Combine(runtimeRoot, "home");
                environmentText += "HOME=" + home + "\0USERPROFILE=" + home +
                    "\0CODEX_HOME=" + Path.Combine(home, ".codex") +
                    "\0APPDATA=" + Path.Combine(runtimeRoot, "AppDataRoaming") +
                    "\0LOCALAPPDATA=" + Path.Combine(runtimeRoot, "AppDataLocal") +
                    "\0TEMP=" + Path.Combine(runtimeRoot, "temp") +
                    "\0TMP=" + Path.Combine(runtimeRoot, "temp") + "\0";
            }
            environment = Marshal.StringToHGlobalUni(environmentText + "\0");
            PROCESS_INFORMATION process;
            if (!CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT |
                CREATE_UNICODE_ENVIRONMENT, environment,
                productionPrepared || claudePrepared ? ownerSourceCwd :
                    configCheck ? Path.Combine(runtimeRoot, "check") : null,
                ref startup, out process))
                throw new StageFailure("PROCESS_CREATE");
            root = process.hProcess; thread = process.hThread;
            CloseHandle(childInput); childInput = IntPtr.Zero;
            CloseHandle(childOutput); childOutput = IntPtr.Zero;
            CloseHandle(childError); childError = IntPtr.Zero;
            bool member;
            if (!IsProcessInJob(root, job, out member) || !member)
                throw new StageFailure("PRE_RESUME_MEMBERSHIP");
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(root, out creation, out exit, out kernel, out user))
                throw new StageFailure("PROCESS_IDENTITY");
            ulong filetime = ((ulong)creation.High << 32) | creation.Low;
            if (filetime == 0 || process.dwProcessId == 0) throw new StageFailure("PROCESS_IDENTITY");
            if (prepared && (lifetime.ElapsedMilliseconds >= wallSeconds * 1000 ||
                !WriterDeadline(preparedUtcTicks, preparedUptimeMs)))
                throw new StageFailure("PREPARED_DEADLINE");
            if (ResumeThread(thread) == UInt32.MaxValue) throw new StageFailure("PROCESS_RESUME");
            CloseHandle(thread); thread = IntPtr.Zero;
            string writer = ownedFixture ? WriterIdentity(host, execution, parentInput, 10, false) : null;
            state.Started(process.dwProcessId, filetime, writer);
            IntPtr outputHandle = parentOutput, errorHandle = parentError, rootHandle = root;
            Task outputTask = Task.Factory.StartNew(() => ReadPipe(outputHandle, "stdout", state),
                TaskCreationOptions.LongRunning);
            Task errorTask = Task.Factory.StartNew(() => ReadPipe(errorHandle, "stderr", state),
                TaskCreationOptions.LongRunning);
            Task rootTask = Task.Factory.StartNew(() => {
                while (true)
                {
                    uint wait = WaitForSingleObject(rootHandle, 100);
                    if (wait == WAIT_OBJECT_0) { state.RootExit(); return; }
                    if (wait != WAIT_TIMEOUT) { lock (state.Gate) state.Fault = true; return; }
                }
            }, TaskCreationOptions.LongRunning);
            int phase = 0;
            while (true)
            {
                string control = AwaitControl(state, lifetime, prepared ? wallSeconds * 1000 : 60000);
                if (control == null) throw new StageFailure("CONTROL_EOF");
                if (control == "stop")
                {
                    if (!TerminateJobObject(job, 0)) throw new StageFailure("JOB_TERMINATE");
                    var drain = Stopwatch.StartNew();
                    while (drain.ElapsedMilliseconds < 5000)
                    {
                        if (state.Fault) throw new StageFailure("PIPE_LIMIT");
                        bool rootExited = RootExited(root);
                        Members members = ReadMembers(job, 500, exe);
                        if (rootExited && members.Assigned == 0 && members.Listed == 0 &&
                            outputTask.IsCompleted && errorTask.IsCompleted && rootTask.IsCompleted &&
                            state.StdoutEof && state.StderrEof && state.RootExitSent)
                        { state.Closed(process.dwProcessId, filetime); return 0; }
                        Thread.Sleep(10);
                    }
                    throw new StageFailure("JOB_NOT_EMPTY");
                }
                if (!ownedPipe && !configCheck && control == "readiness-initialize" && phase == 0)
                { WriteInput(parentInput, Initialize); phase = 1; }
                else if (!prepared && !configCheck && control == "readiness-initialized" && phase == 1)
                { WriteInput(parentInput, Initialized); phase = 2; }
                else if (!prepared && !configCheck && control == "readiness-query" && phase == 2)
                { WriteInput(parentInput, Query); phase = 3; }
                else if (configCheck && control == "config-initialize" && phase == 0)
                { WriteInput(parentInput, ConfigInitialize); phase = 1; }
                else if (configCheck && control == "config-initialized" && phase == 1)
                { WriteInput(parentInput, Initialized); phase = 2; }
                else if (configCheck && control == "config-read" && phase == 2)
                { WriteInput(parentInput, ConfigReadPrefix +
                    JsonString(Path.Combine(runtimeRoot, "check")) +
                    "\",\"includeLayers\":false}}\n"); phase = 3; }
                else if (!ownedPipe && control == "stdin-close" && phase < 4 && parentInput != IntPtr.Zero)
                { CloseHandle(parentInput); parentInput = IntPtr.Zero; phase = 4; }
                else throw new StageFailure("CONTROL_ORDER");
            }
        }
        catch (StageFailure failure) { Console.Error.WriteLine(failure.Code); return 1; }
        catch { Console.Error.WriteLine("STDIO_UNKNOWN"); return 1; }
        finally
        {
            // The unnamed Job is the only process-tree control; closing it kills remaining members.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (root != IntPtr.Zero) CloseHandle(root);
            if (childInput != IntPtr.Zero) CloseHandle(childInput);
            // The original owned server HANDLE must never close/reuse while this helper lives.
            // Process teardown releases it after no more writer can pass live identity checks.
            if (!ownedPipe && parentInput != IntPtr.Zero) CloseHandle(parentInput);
            if (parentOutput != IntPtr.Zero) CloseHandle(parentOutput);
            if (childOutput != IntPtr.Zero) CloseHandle(childOutput);
            if (parentError != IntPtr.Zero) CloseHandle(parentError);
            if (childError != IntPtr.Zero) CloseHandle(childError);
            if (listInitialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (heldConfig != null) heldConfig.Dispose();
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 9 && args[0] == "__write_owned_pipe")
                return WriteOwnedPipe(args, false);
            if (args.Length == 9 && args[0] == "__write_owned_frame")
                return WriteOwnedPipe(args, true);
            if (args.Length == 3 && IsGuid(args[1]) && IsGuid(args[2]) &&
                (args[0] == "single" || args[0] == "tree" || args[0] == "parent_exits"))
                return Host(args[0], args[1], args[2]);
            if (args.Length == 3 && IsGuid(args[1]) && IsGuid(args[2]) &&
                (args[0] == "stdio_fixture_v1" || args[0] == "owned_pipe_fixture_v1"))
                return StdioHost(args[0], args[1], args[2]);
            if (args.Length == 4 && args[0] == "desktop_readiness_v1" &&
                IsGuid(args[1]) && IsGuid(args[2]))
                return StdioHost(args[0], args[1], args[2], null, null, null, 60, 1, args[3]);
            if (args.Length == 6 && args[0] == "desktop_config_check_v1" &&
                IsGuid(args[1]) && IsGuid(args[2]))
                return StdioHost(args[0], args[1], args[2], args[3], args[4], null, 60, 1, args[5]);
            if (args.Length == 2 && args[0] == "desktop_target_check_v1")
            {
                try { ValidateDesktopTarget(args[1]); Console.Out.Write(DesktopVersion); return 0; }
                catch (StageFailure failure) { Console.Error.WriteLine(failure.Code); return 1; }
            }
            int wallSeconds;
            if (args.Length == 4 && args[0] == "prepared_owned_fixture_v1" &&
                IsGuid(args[1]) && IsGuid(args[2]) &&
                Int32.TryParse(args[3], NumberStyles.None, Invariant, out wallSeconds) &&
                wallSeconds >= 1 && wallSeconds <= 600 && wallSeconds.ToString(Invariant) == args[3])
                return StdioHost(args[0], args[1], args[2], null, null, null, wallSeconds);
            if (args.Length == 8 && args[0] == "windows_app_server_readonly_v1" &&
                IsGuid(args[1]) && IsGuid(args[2]) &&
                Int32.TryParse(args[6], NumberStyles.None, Invariant, out wallSeconds) &&
                wallSeconds >= 1 && wallSeconds <= 600 && wallSeconds.ToString(Invariant) == args[6])
                return StdioHost(args[0], args[1], args[2], args[3], args[4], args[5], wallSeconds, 1, args[7]);
            int claudeTurns;
            if (args.Length == 8 && args[0] == "windows_claude_readonly_v1" &&
                IsGuid(args[1]) && IsGuid(args[2]) &&
                Int32.TryParse(args[6], NumberStyles.None, Invariant, out wallSeconds) &&
                wallSeconds >= 1 && wallSeconds <= 600 && wallSeconds.ToString(Invariant) == args[6] &&
                Int32.TryParse(args[7], NumberStyles.None, Invariant, out claudeTurns) &&
                claudeTurns >= 1 && claudeTurns <= 8 && claudeTurns.ToString(Invariant) == args[7])
                return StdioHost(args[0], args[1], args[2], args[3], args[4], args[5],
                    wallSeconds, claudeTurns);
            if (args.Length == 3 && args[0] == "__stdio_fixture" &&
                IsGuid(args[1]) && IsGuid(args[2]))
            { StdioFixture(); return 0; }
            if (args.Length == 3 && args[0] == "__prepared_fixture" &&
                IsGuid(args[1]) && IsGuid(args[2]))
            { PreparedFixture(); return 0; }
            if (args.Length == 4 && IsGuid(args[2]) && IsGuid(args[3]) &&
                (args[0] == "__root" || args[0] == "__child" || args[0] == "__leaf"))
            { Child(args[0], args[1], args[2], args[3]); return 0; }
            Console.Error.WriteLine("ARGUMENTS"); return 1;
        }
        catch { Console.Error.WriteLine("CHILD_UNKNOWN"); return 1; }
    }
}
