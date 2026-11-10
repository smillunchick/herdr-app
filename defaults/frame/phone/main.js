// The phone layout's top bar: the space, its tabs, and the screens a
// desktop shows side by side (the sidebar, Files, Changes) one at a time.
// props().drawer: the sidebar's spaces and agents, opened over the screen.
// props().text: a terminal's screen and history as plain text, to copy (a
// finger drag on the terminal itself scrolls it).
// props().progress: the shown agent's progress note, which herdr-web's server
// keeps as the terminal's `herdr-web.progress` label (empty without it).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { spaces, agents, panes, terminals, focused, hc, run, openOverlay, closeOverlay, props, theme, layout, settings } from "herdr";

const W = (name) => `mods/workspace-chrome/${name}.svg`;
const SCREENS = [["files", "files"], ["changes", "git-compare"], ["progress", "circle-check"]];
const PROGRESS = "herdr-web.progress";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function tabName(c) {
  const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
  return /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
}

// A tap answers with a short vibration, as Android's own controls do.
const tap = (action) => (e, cx) => { run("app.haptic"); action(e, cx); };

// The tab's name when someone named it, else the agent program's.
function agentName(a) {
  const tab = spaces().flatMap(s => s.tabs).find(c => c.id === a.tab);
  return (tab?.named && tab.name) || a.program?.name || a.title || "Agent";
}

// The focused pane's agent, or else the first agent in the shown tab.
function agentShown() {
  const live = terminals().filter((r) => r.status);
  const at = (a) => live.find((r) => r.address === a);
  const tab = spaces().find((s) => s.active)?.tabs.find((c) => c.active)?.id;
  return at(focused()?.terminal) ?? panes().filter((p) => p.tab === tab).map((p) => at(p.terminal)).find(Boolean) ?? null;
}

export default class Phone extends View {
  init(_props, cx) {
    const terminal = props()?.text;
    if (!terminal) return;
    cx.spawn(async (cx) => {
      const r = await hc(["read", terminal, "--lines", "5000", "--json"]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        this.text = JSON.parse(r.stdout).text.replace(/\s+$/, "");
        this.view = EditorState.new({ readonly: true, line_numbers: false, folding: false, soft_wrap: true, value: this.text, font_family: settings().font_family, font_size: 12 });
      } else this.error = r.stderr || "Cannot read this terminal";
      cx.notify();
    });
  }

  textView(t) {
    const close = () => closeOverlay(props().overlay);
    const button = (id, label, action) => div().id(id).px(16).h(44).flex().items_center().rounded(12).bg(t.raised).text_color(t.foreground)
      .active((s) => s.bg(t.hover)).on_click(tap(action)).child(label);
    return v_flex().id("terminal-text").size_full().bg(t.background).text_size(14)
      .child(h_flex().h(60).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_1().text_color(t.muted).child("Terminal text"))
        .when(Boolean(this.view), (el) => el.child(button("text-copy-all", "Copy all", (_e, cx) => { cx.write_to_clipboard(this.text); close(); })))
        .child(button("text-done", "Done", close)))
      .child(this.view ? Editor.new(this.view).flex_1().min_h(0) : div().p(14).text_color(t.dim).child(this.error ?? "Loading…"));
  }

  // Touch has no hover: feedback comes on press, as the finger lands.
  button(t, id, icon, action, on = false) {
    return div().id(id).size(44).flex_none().flex().items_center().justify_center().rounded(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).active(s => s.bg(t.hover).opacity(0.7))
      .on_click(tap(action)).child(typeof icon === "string" ? svg(W(icon)).size(20) : icon);
  }

  progress(t) {
    const agent = agentShown();
    let note = null;
    try { note = JSON.parse(agent?.labels?.[PROGRESS] ?? "null"); } catch {}
    const steps = note?.steps ?? [];
    const empty = !agent ? "Open an agent's tab to see how its task is going."
      : !note ? "No progress yet. Your Herdr server writes it while the agent works."
      : !note.goal ? "No task asked yet." : null;
    const mark = (state) => state === "done" ? svg(W("circle-check")).size(16).text_color(t.ansi2)
      : state === "doing" ? svg(W("spinner")).size(14).m(1).text_color(t.working).spin(900)
      : div().size(14).m(1).rounded(7).border_1().border_color(t.dim);
    return v_flex().id("progress").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(15)
      .when(Boolean(empty), (el) => el.child(div().p(18).text_color(t.dim).child(empty)))
      .when(!empty, (el) => el.child(v_flex().id("progress-body").flex_1().min_h(0).overflow_y_scroll().p(10).gap(4)
        .child(div().px(8).pt(8).pb(12).font_semibold().line_height(1.45).child(note.goal))
        .children(steps.map((s, i) => h_flex().id(`progress-step-${i}`).items_start().gap(12).px(8).py(9).rounded(8)
          .when(s.state === "doing", (e) => e.bg(t.selected))
          .child(div().flex_none().pt(2).child(mark(s.state)))
          .child(div().flex_1().min_w(0).line_height(1.45).text_color(s.state === "done" ? t.muted : t.foreground).child(s.text))))
        .when(Boolean(note.now), (e) => e.child(div().px(8).pt(14).line_height(1.45).text_color(t.muted).child(`Now: ${note.now}`)))));
  }

  drawer(t) {
    const close = () => closeOverlay(props().overlay);
    // Choosing a space or an agent shows it and closes the drawer.
    const choose = (command, args) => () => { run(command, args); close(); };
    const sp = spaces();
    const list = agents();
    const row = (id, label, tail, active, action) => h_flex().id(id).h(52).px(14).gap(12).items_center().rounded(12)
      .bg(active ? t.selected : t.chrome).active(s => s.bg(t.hover)).on_click(tap(action))
      .child(div().flex_1().truncate().text_color(t.foreground).child(label)).child(tail);
    const dot = (status) => div().size(8).flex_none().rounded(4).bg(t[status] ?? "#00000000");
    const header = (label, id, action) => h_flex().h(48).pl(14).pr(4).pt(8).items_center().justify_between().text_size(12.5).text_color(t.dim)
      .child(label).when(Boolean(action), el => el.child(div().id(id).size(44).flex().items_center().justify_center().rounded(12)
        .active(s => s.bg(t.hover)).on_click(tap(action)).child(svg(W("plus")).size(18))));
    return v_flex().size_full().bg(t.chrome).text_size(15).pb(12)
      .child(h_flex().h(56).pl(16).pr(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Herdr"))
        .child(this.button(t, "drawer-close", "x", close)))
      .child(v_flex().id("drawer-list").flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .child(header("Spaces", "drawer-space-new", choose("space.new", {})))
        .children(sp.map(s => row(`drawer-space-${s.id}`, s.name, dot(s.status), s.active, choose("space.select", { id: s.id }))))
        .child(header("Agents"))
        .when(list.length === 0, el => el.child(div().px(14).py(8).text_size(13.5).text_color(t.dim).child("No agents running.")))
        .children(list.map(a => row(`drawer-agent-${a.address}`, agentName(a),
          a.status === "blocked" ? div().px(7).h(20).flex().items_center().rounded(6).bg(t.blocked + "26").text_size(11.5).font_semibold().text_color(t.blocked).child("Needs you") : dot(a.status),
          a.focused, choose("agent.focus", { terminal: a.address })))))
      .child(v_flex().px(6).pt(8).border_t(1).border_color(t.border)
        .child(row("drawer-settings", "Settings", div(), false, choose("app.settings", {})))
        .child(row("drawer-machine", "Add machine", div(), false, choose("mod.open", { name: "machine-add" }))));
  }

  render() {
    const t = theme();
    if (props()?.drawer) return this.drawer(t);
    if (props()?.text) return this.textView(t);
    if (props()?.progress) return this.progress(t);
    const space = spaces().find(s => s.active);
    const tabs = space?.tabs ?? [];
    const screen = find(layout(), "screen")?.active ?? "main";
    const needs = agents().filter(a => a.status === "blocked").length;
    // Slides in from the left edge, the way it closes back out of sight.
    const openDrawer = () => openOverlay({ mod: "frame-phone", kind: "dialog", at: "left", width: 0.86, height: 1, props: { drawer: true } });
    const tab = (c) => {
      const name = tabName(c);
      return h_flex().id(`phone-tab-${c.id}`).h(44).px(14).gap(7).flex_none().items_center().rounded(12)
        .bg(c.active && screen === "main" ? t.selected : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .active(s => s.bg(t.hover))
        .on_click(tap(() => { run("tab.select", { id: c.id }); run("layout.select", { stack: "screen", child: "main" }); }))
        .child(div().max_w(150).truncate().child(name))
        .when(c.status === "working", el => el.child(svg(W("spinner")).size(12).text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(7).rounded(4).bg(t[c.status])));
    };
    return v_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).text_size(14)
      .child(h_flex().h(52).px(4).gap(2).items_center()
        .child(div().relative().child(this.button(t, "phone-menu", "sidebar", openDrawer))
          .when(needs > 0, el => el.child(div().absolute().top(8).right(8).size(9).rounded(5).bg(t.blocked))))
        .child(div().flex_1().min_w(0).px(4).truncate().font_semibold().text_color(t.foreground).child(space?.name ?? "Herdr"))
        .children(SCREENS.map(([id, icon]) => this.button(t, `phone-${id}`, icon,
          () => run("layout.select", { stack: "screen", child: screen === id ? "main" : id }), screen === id)))
        .child(this.button(t, "phone-search", "search", () => run("mod.open", { name: "picker" }))))
      .child(h_flex().id("phone-tabs").h(48).px(4).gap(2).items_center().overflow_x_scrollbar()
        .children(tabs.map(tab))
        .child(div().id("phone-tab-new").size(44).flex_none().flex().items_center().justify_center().rounded(12).text_color(t.muted)
          .active(s => s.bg(t.hover)).on_click(tap(() => openOverlay({ mod: "new-menu", kind: "popup", at: "top", offset: 100, width: 300, height: 512 })))
          .child(svg(W("plus")).size(18))));
  }
}
