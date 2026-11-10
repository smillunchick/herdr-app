//! Android's navigation drawer: an overlay opened `at: "left"` slides in from
//! the left edge over a dimmed screen. While a finger drags it, it follows the
//! finger 1:1; on release it settles open or closed by distance or by a fling,
//! from where the finger left it. No edge swipe opens it: with gesture
//! navigation Android keeps the screen edges for its own Back.

use super::{AppWindow, Overlay};
use gpui::*;
use std::time::{Duration, Instant};

/// Opening and settling: Android's emphasized deceleration, steep at first so
/// it answers at once, then a soft landing. No bounce on a button press.
const SETTLE: Duration = Duration::from_millis(300);
/// Release past this share of the width, or flung faster than this, settles open.
const OPEN_SHARE: f32 = 0.5;
const FLING: f32 = 600.0;

fn curve(t: f32) -> f32 {
    gpui_base::animation::cubic_bezier(0.05, 0.7, 0.1, 1.0)(t)
}

/// How far a drawer is shown, 0 (closed) to 1 (open), and where that is going.
#[derive(Clone, Copy)]
pub(super) enum Motion {
    /// Settling from `from` toward `to` since `at`.
    Settle { from: f32, to: f32, at: Instant },
    /// Under the finger: `shown` now, `velocity` in widths per second.
    Track { shown: f32, x: f32, at: Instant, velocity: f32 },
}

impl Motion {
    pub(super) fn opening() -> Self {
        Motion::Settle { from: 0.0, to: 1.0, at: Instant::now() }
    }

    fn shown(self, reduce: bool) -> f32 {
        match self {
            Motion::Track { shown, .. } => shown,
            Motion::Settle { to, .. } if reduce => to,
            Motion::Settle { from, to, at } => {
                let t = (at.elapsed().as_secs_f32() / SETTLE.as_secs_f32()).min(1.0);
                from + (to - from) * curve(t)
            }
        }
    }

    fn settled(self) -> bool {
        matches!(self, Motion::Settle { at, .. } if at.elapsed() >= SETTLE)
    }

    /// Settled shut: out of sight, so it can go.
    pub(super) fn closed(self) -> bool {
        matches!(self, Motion::Settle { to, .. } if to == 0.0) && self.settled()
    }
}

impl AppWindow {
    pub(super) fn render_drawer(&self, o: &Overlay, motion: Motion, body: Stateful<Div>, width: Pixels, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let shown = motion.shown(cx.reduce_motion());
        if matches!(motion, Motion::Settle { .. }) && !motion.settled() {
            window.request_animation_frame();
        }
        // Closed: gone once it is out of sight.
        if motion.closed() {
            let id = o.id.clone();
            cx.defer_in(window, move |this, w, cx| this.close_overlay(&id, w, cx));
        }
        let id = o.id.clone();
        let drag_id = o.id.clone();
        let this = cx.entity().downgrade();
        div()
            .absolute()
            .inset_0()
            .bg(hsla(0.0, 0.0, 0.0, 0.4 * shown))
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, w, cx| this.settle_drawer(&id, 0.0, w, cx)))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(-width * (1.0 - shown))
                    .w(width)
                    .occlude()
                    .shadow_lg()
                    .child(body.h_full().rounded_none().border_0()),
            )
            // Claimed before a tap or a scroll is decided, so the drawer is the finger.
            .child(canvas(|_, _, _| {}, move |bounds, _, window, _| {
                let this = this.clone();
                let drag_id = drag_id.clone();
                window.on_mouse_event(move |event: &TouchDragEvent, phase, window, cx| {
                    if phase.bubble() && bounds.contains(&event.start_position) {
                        let _ = this.update(cx, |this, cx| this.drag_drawer(&drag_id, event, width, window, cx));
                    }
                });
            }).absolute().inset_0())
            .into_any_element()
    }

    /// Settles the drawer toward open (1) or closed (0) from wherever it is.
    pub(super) fn settle_drawer(&mut self, id: &str, to: f32, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = cx.reduce_motion();
        if let Some(o) = self.overlays.iter_mut().find(|o| o.id == id)
            && let Some(motion) = o.drawer
        {
            o.drawer = Some(Motion::Settle { from: motion.shown(reduce), to, at: Instant::now() });
        }
        window.refresh();
    }

    fn drag_drawer(&mut self, id: &str, event: &TouchDragEvent, width: Pixels, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = cx.reduce_motion();
        let Some(o) = self.overlays.iter_mut().find(|o| o.id == id) else { return };
        let Some(motion) = o.drawer else { return };
        let x = f32::from(event.position.x);
        let width = f32::from(width).max(1.0);
        o.drawer = match (event.phase, motion) {
            (TouchPhase::Started, m) => Some(Motion::Track { shown: m.shown(reduce), x, at: Instant::now(), velocity: 0.0 }),
            (TouchPhase::Moved, Motion::Track { shown, x: last, at, .. }) => {
                let step = (x - last) / width;
                let seconds = at.elapsed().as_secs_f32().max(0.001);
                Some(Motion::Track { shown: (shown + step).clamp(0.0, 1.0), x, at: Instant::now(), velocity: step / seconds })
            }
            (TouchPhase::Ended | TouchPhase::Cancelled, Motion::Track { shown, velocity, .. }) => {
                let fling = velocity * width;
                let open = if fling.abs() > FLING { fling > 0.0 } else { shown > OPEN_SHARE };
                Some(Motion::Settle { from: shown, to: if open { 1.0 } else { 0.0 }, at: Instant::now() })
            }
            (_, m) => Some(m),
        };
        window.prevent_default();
        cx.stop_propagation();
        window.refresh();
    }

}
