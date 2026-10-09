//! Pet window moves without ghosts.
//!
//! Root cause of "a piece of her head left behind": her window is transparent
//! and always-on-top. When it moves (strolls) or shrinks, Windows is supposed to
//! repaint whatever is underneath, but some apps (uTorrent's ad pane was the one
//! on Frank's PC) never repaint the vacated area, so the last frame of her stays
//! burnt onto their window. After every move / resize we now explicitly
//! invalidate the screen rectangle she just left (RedrawWindow on the desktop,
//! all children) so the windows below redraw it.

use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Parts of `old` not covered by `new` (up to 4 strips).
pub fn vacated(old: Rect, new: Rect) -> Vec<Rect> {
    let (ox2, oy2) = (old.x + old.w, old.y + old.h);
    let (nx2, ny2) = (new.x + new.w, new.y + new.h);
    let ix1 = old.x.max(new.x);
    let iy1 = old.y.max(new.y);
    let ix2 = ox2.min(nx2);
    let iy2 = oy2.min(ny2);
    if ix1 >= ix2 || iy1 >= iy2 {
        return vec![old];
    }
    let mut out = Vec::new();
    if old.y < iy1 {
        out.push(Rect { x: old.x, y: old.y, w: old.w, h: iy1 - old.y });
    }
    if iy2 < oy2 {
        out.push(Rect { x: old.x, y: iy2, w: old.w, h: oy2 - iy2 });
    }
    if old.x < ix1 {
        out.push(Rect { x: old.x, y: iy1, w: ix1 - old.x, h: iy2 - iy1 });
    }
    if ix2 < ox2 {
        out.push(Rect { x: ix2, y: iy1, w: ox2 - ix2, h: iy2 - iy1 });
    }
    out
}

#[cfg(windows)]
pub fn invalidate_screen(r: Rect) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
    };
    if r.w <= 0 || r.h <= 0 {
        return;
    }
    // Small margin: anti-aliased edges / DPI rounding.
    let rc = RECT { left: r.x - 2, top: r.y - 2, right: r.x + r.w + 2, bottom: r.y + r.h + 2 };
    unsafe {
        RedrawWindow(
            std::ptr::null_mut(),
            &rc,
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME,
        );
    }
}

#[cfg(not(windows))]
pub fn invalidate_screen(_r: Rect) {}

fn current_rect(w: &WebviewWindow) -> Option<Rect> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    Some(Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 })
}

/// Move (and optionally resize) the pet window in physical px, then repaint
/// whatever she uncovered.
#[tauri::command(async)]
pub fn pet_set_bounds(
    window: WebviewWindow,
    x: i32,
    y: i32,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    let old = current_rect(&window);
    if let (Some(w), Some(h)) = (width, height) {
        window
            .set_size(PhysicalSize::new(w.max(200), h.max(240)))
            .map_err(|e| e.to_string())?;
    }
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    if let (Some(old), Some(new)) = (old, current_rect(&window)) {
        if old != new {
            for r in vacated(old, new) {
                invalidate_screen(r);
            }
        }
    }
    Ok(())
}

/// Repaint the area under/around her (end of a stroll / drag / hide).
#[tauri::command(async)]
pub fn pet_repaint_behind(window: WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    let _ = window;
    invalidate_screen(Rect { x, y, w: width, h: height });
}

/// Hide to tray and repaint where she was.
pub fn hide_clean(w: &WebviewWindow) {
    let r = current_rect(w);
    let _ = w.hide();
    if let Some(r) = r {
        invalidate_screen(r);
    }
}

#[tauri::command(async)]
pub fn pet_hide(window: WebviewWindow) {
    hide_clean(&window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vacated_strip_when_moving_right() {
        let v = vacated(Rect { x: 0, y: 0, w: 100, h: 50 }, Rect { x: 10, y: 0, w: 100, h: 50 });
        assert_eq!(v, vec![Rect { x: 0, y: 0, w: 10, h: 50 }]);
    }

    #[test]
    fn vacated_all_when_disjoint() {
        let o = Rect { x: 0, y: 0, w: 10, h: 10 };
        assert_eq!(vacated(o, Rect { x: 50, y: 50, w: 10, h: 10 }), vec![o]);
    }

    #[test]
    fn shrink_vacates_top_and_side() {
        let v = vacated(Rect { x: 0, y: 0, w: 100, h: 100 }, Rect { x: 0, y: 40, w: 60, h: 60 });
        assert_eq!(v.len(), 2);
    }
}
