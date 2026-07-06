# C# Wrapper 崩溃问题分析

## 一、崩溃事实

### 1.1 崩溃现象
- **应用名称**: `Live2DRenderer.exe`（C# Wrapper，.NET 8 单文件发布）
- **异常代码**: `0xe0434352`（.NET CLR 异常）
- **错误模块**: `KERNELBASE.dll`
- **崩溃时刻**: WPF 端通过 `Process.Start` 启动 `Live2DRenderer.exe` 时立即崩溃
- **用户报告的 exitCode**: `-532462766`（即 `0xE06D7363`，C++ 运行时异常码，但事件查看器实际记录的是 `0xe0434352`）

### 1.2 Windows 事件查看器记录（共 4 次，时间相同）
所有崩溃的堆栈完全一致：

```
Application: Live2DRenderer.exe
CoreCLR Version: 8.0.224.6711
.NET Version: 8.0.2
Description: The process was terminated due to an unhandled exception.
Exception Info: System.IO.IOException: 句柄无效。
   at System.ConsolePal.SetConsoleInputEncoding(Encoding)
   at System.Console.set_InputEncoding(Encoding)
   at Program.<Main>$(String[])
   at Program.<Main>(String[])
```

崩溃发生时间点：
- 2026/7/5 20:36:00
- 2026/7/5 20:40:00
- 2026/7/5 20:43:20
- 2026/7/5 20:56:22

### 1.3 关键观察
- 直接双击 `Live2DRenderer.exe` 运行**不会崩溃**
- 通过 WPF 启动**立即崩溃**
- 崩溃堆栈固定指向 `Console.set_InputEncoding`（即使代码已用 try-catch 包裹）

---

## 二、当前代码

### 2.1 Program.cs 当前内容

文件路径: `c:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron\wrapper\Program.cs`

```csharp
using System.Diagnostics;

var baseDirectory = AppContext.BaseDirectory;
var hostPath = Path.Combine(baseDirectory, "Live2DRendererHost.exe");

if (!File.Exists(hostPath))
{
    return 2;
}

// ...参数解析...

host.Start();

var stdinTask = Task.Run(async () =>
{
    try
    {
        var stdin = Console.OpenStandardInput();          // ← 问题点 1
        var hostStdin = host.StandardInput.BaseStream;
        await stdin.CopyToAsync(hostStdin);
    }
    catch { }
    try { host.StandardInput.Close(); } catch { }
});

var stdoutTask = Task.Run(async () =>
{
    try
    {
        var stdout = Console.OpenStandardOutput();        // ← 问题点 2
        var hostStdout = host.StandardOutput.BaseStream;
        await hostStdout.CopyToAsync(stdout);
    }
    catch { }
});

var stderrTask = Task.Run(async () =>
{
    try
    {
        var stderr = Console.OpenStandardError();         // ← 问题点 3
        using var writer = new System.IO.StreamWriter(stderr) { AutoFlush = true };
        string? line;
        while ((line = await host.StandardError.ReadLineAsync()) is not null)
        {
            await writer.WriteLineAsync(line);
        }
    }
    catch { }
});

await host.WaitForExitAsync();
await Task.WhenAny(Task.WhenAll(stdinTask, stdoutTask, stderrTask), Task.Delay(500));

return host.ExitCode;
```

### 2.2 已尝试的修复
1. **第一次修复**：用 try-catch 包裹启动时的编码设置
   ```csharp
   try
   {
       Console.InputEncoding = new UTF8Encoding(false);
       Console.OutputEncoding = new UTF8Encoding(false);
       Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
   }
   catch { }
   ```
   - **结果**：依然崩溃

2. **第二次修复**：完全移除启动时的编码设置代码
   - **结果**：依然崩溃

3. **第三次修复**：在 Task.Run 内部用 try-catch 包裹所有 Console 调用
   - **结果**：依然崩溃

---

## 三、需要回答的问题

### 问题 1：WPF 是如何启动 `Live2DRenderer.exe` 的？
需要 WPF 端的启动代码，特别是：
- `ProcessStartInfo` 的配置（`UseShellExecute`、`CreateNoWindow`、`RedirectStandardInput/Output/Error`、`WindowStyle` 等）
- 是否设置了 `StandardInputEncoding` / `StandardOutputEncoding`
- 是否传递了 `--pipe-name` 参数（决定是否进入 AI_maid 模式）

### 问题 2：崩溃堆栈为何仍指向 `Console.set_InputEncoding`？
当前 `Program.cs` **已经没有**任何 `Console.InputEncoding = ...` 的代码，但事件查看器记录的崩溃堆栈仍指向 `Console.set_InputEncoding`。可能原因：
- WPF 端设置了 `processStartInfo.StandardInputEncoding`
- WPF 端调用了 `process.StandardInput.WriteLine(...)` 触发了底层编码设置
- .NET 运行时在进程启动时隐式调用了 `Console.set_InputEncoding`
- 旧的 `Live2DRenderer.exe` 文件还在执行（未更新）

### 问题 3：当前运行的 `Live2DRenderer.exe` 是否真的是最新构建的？
- 每次修改 `Program.cs` 后，是否真正替换了 `release\MaidAI\Live2DRenderer\Live2DRenderer.exe`？
- 是否存在文件被占用导致替换失败的情况？

### 问题 4：WPF 是否使用了 `RedirectStandardInput` 且调用 `WriteLine`？
如果 WPF 设置了 `RedirectStandardInput = true` 并调用 `process.StandardInput.WriteLine(...)`，子进程的 `Console.In` 会被重定向。但子进程在 `Task.Run` 中调用 `Console.OpenStandardInput()` 可能仍会失败，因为：
- 在没有控制台窗口且标准句柄被重定向时，`Console.OpenStandardInput()` 可能返回 `Stream.Null`
- 但在某些 .NET 运行时版本中，可能抛出 `IOException: 句柄无效`

---

## 四、需要 WPF 端提供的代码

请提供以下 WPF 端的代码：

1. **启动 `Live2DRenderer.exe` 的代码**
   ```csharp
   // 类似这样的代码：
   var psi = new ProcessStartInfo
   {
       FileName = "...",
       Arguments = "...",
       UseShellExecute = ?,
       CreateNoWindow = ?,
       RedirectStandardInput = ?,
       RedirectStandardOutput = ?,
       RedirectStandardError = ?,
       // ...
   };
   ```

2. **与 Wrapper 通信的代码**
   - 是否调用 `process.StandardInput.WriteLine(...)`？
   - 是否监听 `process.OutputDataReceived` / `process.ErrorDataReceived`？
   - 是否设置了 `StandardInputEncoding` / `StandardOutputEncoding`？

3. **WPF 端捕获到的崩溃信息**
   - WPF 端 `process.Exited` 事件中获取到的 `ExitCode` 是多少？
   - 是否有 WPF 端的异常日志？

---

## 五、可重现的测试用例

为了精确定位问题，请提供一个最小的 WPF 启动代码，例如：

```csharp
var psi = new ProcessStartInfo
{
    FileName = @"C:\Users\49213\Desktop\A\codex\Live\release\MaidAI\Live2DRenderer\Live2DRenderer.exe",
    UseShellExecute = false,
    CreateNoWindow = true,
    // ↓↓↓ 请补充实际使用的参数 ↓↓↓
    RedirectStandardInput = ?,
    RedirectStandardOutput = ?,
    RedirectStandardError = ?,
};
var process = new Process { StartInfo = psi };
process.Start();
```

这样可以在不依赖 WPF 的其他逻辑的情况下复现崩溃。

---

## 六、附：事件查看器完整崩溃记录

```
TimeCreated : 2026/7/5 20:56:22
Id          : 1026
Message     : Application: Live2DRenderer.exe
              CoreCLR Version: 8.0.224.6711
              .NET Version: 8.0.2
              Description: The process was terminated due to an unhandled exception.
              Exception Info: System.IO.IOException: 句柄无效。
                 at System.ConsolePal.SetConsoleInputEncoding(Encoding)
                 at System.Console.set_InputEncoding(Encoding)
                 at Program.<Main>$(String[])
                 at Program.<Main>(String[])

TimeCreated : 2026/7/5 20:56:22
Id          : 1000
Message     : 错误应用程序名称: Live2DRenderer.exe，版本: 1.0.0.0，时间戳: 0x65a89639
              错误模块名称: KERNELBASE.dll，版本: 10.0.19041.6280，时间戳: 0x56511854
              异常代码: 0xe0434352
              错误偏移量: 0x0000000000025369
              错误进程 ID: 0x7f20
              错误应用程序路径: C:\Users\49213\Desktop\A\codex\Live\release\MaidAI\Live2DRenderer\Live2DRenderer.exe
              错误模块路径: C:\Windows\System32\KERNELBASE.dll
```
