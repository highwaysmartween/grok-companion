//! Type spoken text into the Grok CLI terminal on this machine.
//! The companion is the ears; the already-open Grok TUI is the brain.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindow {
    pub hwnd: String,
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub is_grok: bool,
}

fn ps(script: &str) -> Result<std::process::Output, String> {
    Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(|e| format!("Could not start PowerShell: {e}"))
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[tauri::command]
pub async fn list_grok_windows() -> Result<Vec<DesktopWindow>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
$skip = @('grok-desktop-companion','Grok Bot')
$out = @()
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  if ($skip -contains $_.ProcessName) { return }
  $title = $_.MainWindowTitle
  $isGrok = ($title -match '(?i)(?:^|\s)grok(?:\s|$)| - grok$') -or ($_.ProcessName -eq 'grok')
  $out += [pscustomobject]@{
    hwnd = [string][int64]$_.MainWindowHandle
    title = $title
    process = $_.ProcessName
    pid = $_.Id
    isGrok = [bool]$isGrok
  }
}
if ($out.Count -eq 0) { '[]' }
elseif ($out.Count -eq 1) { '[' + ($out | ConvertTo-Json -Compress) + ']' }
else { $out | ConvertTo-Json -Compress }
"#;

    let output = tauri::async_runtime::spawn_blocking(move || ps(script))
        .await
        .map_err(|e| format!("list windows task failed: {e}"))??;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Could not list windows: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() || text == "null" {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("Window list parse error: {e} ({text})"))
}

const INJECT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int s);
  public const int INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public InputUnion U;
  }
  public static void TypeText(string text) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') {
        list.Add(Vk(0x0D, false));
        list.Add(Vk(0x0D, true));
        continue;
      }
      list.Add(Uni(ch, false));
      list.Add(Uni(ch, true));
    }
    list.Add(Vk(0x0D, false));
    list.Add(Vk(0x0D, true));
    var arr = list.ToArray();
    SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  static INPUT Uni(char ch, bool up) {
    var i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki.wVk = 0;
    i.U.ki.wScan = ch;
    i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }
  static INPUT Vk(ushort vk, bool up) {
    var i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki.wVk = vk;
    i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }
}
"@
function Get-GrokTuiHwnd {
  $skip = @('grok-desktop-companion','Grok Bot')
  $wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($skip -notcontains $_.ProcessName) }
  $hit = $wins | Where-Object { $_.MainWindowTitle -match '(?i)(?:^|\s)grok(?:\s|$)| - grok$' } | Select-Object -First 1
  if ($hit) { return [int64]$hit.MainWindowHandle }
  $grok = Get-Process -Name grok -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($grok) {
    $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$($grok.Id)").ParentProcessId
    $parent = $wins | Where-Object { $_.Id -eq $parentId } | Select-Object -First 1
    if ($parent) { return [int64]$parent.MainWindowHandle }
  }
  return 0
}
$hwndVal = [int64]__HWND__
if ($hwndVal -eq 0) { $hwndVal = Get-GrokTuiHwnd }
if ($hwndVal -eq 0) {
  Write-Error 'Could not find your Grok terminal. Click that window once, then try again.'
  exit 3
}
$ptr = [IntPtr]$hwndVal
if (-not [WinInput]::IsWindow($ptr)) {
  Write-Error 'That Grok window is gone. Click the terminal, then talk again.'
  exit 3
}
if ([WinInput]::IsIconic($ptr)) { [WinInput]::ShowWindow($ptr, 9) | Out-Null }
[WinInput]::BringWindowToTop($ptr) | Out-Null
[WinInput]::SetForegroundWindow($ptr) | Out-Null
Start-Sleep -Milliseconds 140
[WinInput]::TypeText(__TEXT__)
Write-Output ("typed:" + $hwndVal)
"#;

#[tauri::command]
pub async fn inject_to_grok_terminal(text: String, hwnd: Option<String>) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("Nothing to type.".into());
    }
    if trimmed.chars().count() > 8000 {
        return Err("That message is too long to type into the terminal.".into());
    }

    let hwnd_lit = match hwnd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(h) => ps_quote(h),
        None => "0".into(),
    };
    let text_lit = ps_quote(&trimmed);
    let script = INJECT_SCRIPT
        .replace("__HWND__", &hwnd_lit)
        .replace("__TEXT__", &text_lit);

    let output = tauri::async_runtime::spawn_blocking(move || ps(&script))
        .await
        .map_err(|e| format!("inject task failed: {e}"))??;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg = err.trim();
        return Err(if msg.is_empty() {
            "Could not type into the Grok terminal.".into()
        } else {
            msg.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
