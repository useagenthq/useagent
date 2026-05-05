import { c5 as y, c4 as b, cm as k, cb as v, c8 as D, bV as S, b$ as $, aC as _, at as d, L as w, b6 as u, b as L, aV as P, ak as C, bG as F, bL as I } from "./skynet-element-dDv65e_D.js";
var T = /* @__PURE__ */ I('<div class="w-full flex items-center gap-2"><span class="truncate flex-1 min-w-0 text-left font-normal"></span><span class="text-text-weak shrink-0 font-normal">');
function E(i) {
  return i.toLocaleTimeString(void 0, {
    timeStyle: "short"
  });
}
const M = () => {
  const i = y(), g = b(), c = k(), l = v(), p = D(), f = S(), o = $(), h = _(() => {
    const t = i.id;
    if (!t) return [];
    const a = c().data.message[t] ?? [], n = [];
    for (const s of a) {
      if (s.role !== "user") continue;
      const e = (c().data.part[s.id] ?? []).find((r) => r.type === "text" && !r.synthetic && !r.ignored);
      e && n.push({
        id: s.id,
        text: e.text.replace(/\n/g, " ").slice(0, 200),
        time: E(new Date(s.time.created))
      });
    }
    return n.reverse();
  }), x = (t) => {
    if (!t) return;
    const a = i.id;
    if (!a) return;
    const n = c().data.part[t.id] ?? [], s = P(n, {
      directory: l().directory,
      attachmentName: o.t("common.attachment")
    }), m = C(l().directory);
    l().api.session.fork({
      sessionID: a,
      messageID: t.id
    }).then((e) => {
      f.close(), p.set(s, void 0, {
        dir: m,
        id: e.id
      }), g(`/${m}/session/${e.id}`);
    }).catch((e) => {
      const r = e instanceof Error ? e.message : String(e);
      F({
        title: o.t("common.requestFailed"),
        description: r
      });
    });
  };
  return d(L, {
    get title() {
      return o.t("command.session.fork");
    },
    get children() {
      return d(w, {
        class: "flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0",
        get search() {
          return {
            placeholder: o.t("common.search.placeholder"),
            autofocus: !0
          };
        },
        get emptyMessage() {
          return o.t("dialog.fork.empty");
        },
        key: (t) => t.id,
        items: h,
        filterKeys: ["text"],
        onSelect: x,
        children: (t) => (() => {
          var a = T(), n = a.firstChild, s = n.nextSibling;
          return u(n, () => t.text), u(s, () => t.time), a;
        })()
      });
    }
  });
};
export {
  M as DialogFork
};
