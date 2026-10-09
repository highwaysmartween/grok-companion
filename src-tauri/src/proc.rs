//! Small process helpers shared by the voice / brain modules.
//!
//! * Every child process is spawned without a console window on Windows
//!   (release builds use the GUI subsystem, so a plain `Command::new("powershell")`
//!   would flash a console each time the wake loop re-arms).
//! * Long-running children register their PID in an `AtomicU32` slot so a
//!   separate command (stop / cancel) can kill the whole process tree.

use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command::new` that never pops a console window on Windows.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Kill a process and its children. No-op for pid 0.
pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = command("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Kill whatever PID is registered in `slot` (and clear it).
pub fn kill_slot(slot: &AtomicU32) {
    kill_tree(slot.swap(0, Ordering::SeqCst));
}

/// Spawn `cmd` with piped output, register its PID in `slot`, wait for it,
/// then clear the slot (only if it still holds our PID). If `still_wanted()` is
/// false right after the PID is registered (a cancel raced the spawn), the
/// child is killed immediately.
pub fn run_tracked_checked(
    mut cmd: Command,
    slot: &AtomicU32,
    still_wanted: &dyn Fn() -> bool,
) -> Result<Output, String> {
    let child: Child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {:?}: {e}", cmd.get_program()))?;
    let pid = child.id();
    slot.store(pid, Ordering::SeqCst);
    if !still_wanted() {
        kill_tree(pid);
    }
    let out = child.wait_with_output();
    let _ = slot.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    out.map_err(|e| format!("process wait failed: {e}"))
}

/// Unique temp file path, e.g. `grok-companion-tts-<uuid>.mp3`.
pub fn temp_file(prefix: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "grok-companion-{prefix}-{}.{ext}",
        uuid::Uuid::new_v4().simple()
    ))
}

/// Deletes the file when dropped (best effort).
pub struct TempFile(pub PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
