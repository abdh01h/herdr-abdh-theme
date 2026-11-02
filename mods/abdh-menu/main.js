// abdh menu: a small pointer popup. Items either run an app command or
// publish a shared action for the mod that owns it.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, run, setShared, theme } from "herdr";

export default class Menu extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const items = p.items ?? [];
    const pick = (item) => {
      closeOverlay(p.overlay);
      if (item.command) run(item.command, item.args ?? {});
      else if (item.shared) setShared(item.shared, { ...(item.value ?? {}), nonce: `${Date.now()}-${Math.random()}` });
    };
    return v_flex().id("abdh-menu").w_full().p(4).gap(1).bg(t.popover).text_size(12.5).text_color(t.muted)
      .when(Boolean(p.title), (el) => el.child(div().px(8).pt(4).pb(5).text_size(11).text_color(t.dim).child(p.title)))
      .children(items.map((item, i) => item.separator
        ? div().id(`sep-${i}`).mx(6).my(3).h(1).bg(t.border)
        : h_flex().id(`menu-${i}`).h(27).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .text_color(item.danger ? t.blocked : t.muted)
          .hover((s) => s.bg(t.hover).text_color(item.danger ? t.blocked : t.foreground))
          .on_click(() => pick(item))
          .child(div().flex_1().truncate().child(item.label))
          .when(Boolean(item.hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(item.hint)))));
  }
}
