import { b$ as D, at as s, ai as u, b6 as r, aa as z, a2 as L, aH as y, bF as m, A as O, bc as A, aZ as E, b1 as T, I as H, bQ as K, o as M, ao as P, B as I, ba as Q, b as V, bL as g, aR as Y } from "./skynet-element-dDv65e_D.js";
import { c as Z } from "./edit-project-aAst2tN1.js";
var q = /* @__PURE__ */ g('<div class="flex flex-col gap-2"><label class="text-12-medium text-text-weak"></label><div class="flex gap-1.5">'), G = /* @__PURE__ */ g('<form class="flex flex-col gap-6 p-6 pt-0"><div class="flex flex-col gap-4"><div class="flex flex-col gap-2"><label class="text-12-medium text-text-weak"></label><div class="flex gap-3 items-start"><div class=relative><div class="relative size-16 rounded-md transition-colors cursor-pointer"></div><div class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"></div><div class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"></div></div><input id=icon-upload type=file accept=image/* class=hidden><div class="flex flex-col gap-1.5 text-12-regular text-text-weak self-center"><span></span><span></span></div></div></div></div><div class="flex justify-end gap-2">'), J = /* @__PURE__ */ g('<div class="size-full flex items-center justify-center">'), U = /* @__PURE__ */ g('<img class="size-full object-cover">'), W = /* @__PURE__ */ g("<button type=button>");
const X = ["pink", "mint", "orange", "purple", "cyan", "lime"];
function re(b) {
  const a = D(), e = Z(b);
  return s(V, {
    get title() {
      return a.t("dialog.project.edit.title");
    },
    class: "w-full max-w-[480px] mx-auto",
    get children() {
      var x = G(), v = x.firstChild, w = v.firstChild, $ = w.firstChild, R = $.nextSibling, f = R.firstChild, d = f.firstChild, p = d.nextSibling, h = p.nextSibling, j = f.nextSibling, F = j.nextSibling, k = F.firstChild, N = k.nextSibling, _ = v.nextSibling;
      return u(x, "submit", e.submit), r(v, s(z, {
        autofocus: !0,
        type: "text",
        get label() {
          return a.t("dialog.project.edit.name");
        },
        get placeholder() {
          return e.folderName();
        },
        get value() {
          return e.store.name;
        },
        onChange: (t) => e.setStore("name", t)
      }), w), r($, () => a.t("dialog.project.edit.icon")), f.addEventListener("mouseleave", () => e.setStore("iconHover", !1)), f.addEventListener("mouseenter", () => e.setStore("iconHover", !0)), u(d, "click", e.iconClick, !0), u(d, "dragleave", e.dragLeave), u(d, "dragover", e.dragOver), u(d, "drop", e.drop), r(d, s(L, {
        get when() {
          return T(b.project.id, {
            color: e.store.color,
            url: b.project.icon?.url,
            override: e.store.iconOverride
          });
        },
        get fallback() {
          return (() => {
            var t = J();
            return r(t, s(O, A({
              get fallback() {
                return e.store.name || e.defaultName();
              }
            }, () => E(e.store.color), {
              class: "size-full text-[32px]"
            }))), t;
          })();
        },
        children: (t) => (() => {
          var c = U();
          return y((l) => {
            var o = t(), i = a.t("dialog.project.edit.icon.alt");
            return o !== l.e && m(c, "src", l.e = o), i !== l.t && m(c, "alt", l.t = i), l;
          }, {
            e: void 0,
            t: void 0
          }), c;
        })()
      })), r(p, s(H, {
        name: "cloud-upload",
        size: "large",
        class: "text-icon-on-interactive-base drop-shadow-sm"
      })), r(h, s(H, {
        name: "trash",
        size: "large",
        class: "text-icon-on-interactive-base drop-shadow-sm"
      })), u(j, "change", e.inputChange), K((t) => {
        e.setIconInput(t);
      }, j), r(k, () => a.t("dialog.project.edit.icon.hint")), r(N, () => a.t("dialog.project.edit.icon.recommended")), r(v, s(L, {
        get when() {
          return !e.store.iconOverride;
        },
        get children() {
          var t = q(), c = t.firstChild, l = c.nextSibling;
          return r(c, () => a.t("dialog.project.edit.color")), r(l, s(M, {
            each: X,
            children: (o) => (() => {
              var i = W();
              return i.$$click = () => {
                e.store.color === o && !b.project.icon?.url || e.setStore("color", e.store.color === o ? void 0 : o);
              }, r(i, s(O, A({
                get fallback() {
                  return e.store.name || e.defaultName();
                }
              }, () => E(o), {
                class: "size-full rounded"
              }))), y((n) => {
                var S = a.t("dialog.project.edit.color.select", {
                  color: o
                }), C = e.store.color === o, B = {
                  "flex items-center justify-center size-10 p-0.5 rounded-lg overflow-hidden transition-colors cursor-default": !0,
                  "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": e.store.color === o,
                  "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base": e.store.color !== o
                };
                return S !== n.e && m(i, "aria-label", n.e = S), C !== n.t && m(i, "aria-pressed", n.t = C), n.a = P(i, B, n.a), n;
              }, {
                e: void 0,
                t: void 0,
                a: void 0
              }), i;
            })()
          })), t;
        }
      }), null), r(v, s(z, {
        multiline: !0,
        get label() {
          return a.t("dialog.project.edit.worktree.startup");
        },
        get description() {
          return a.t("dialog.project.edit.worktree.startup.description");
        },
        get placeholder() {
          return a.t("dialog.project.edit.worktree.startup.placeholder");
        },
        get value() {
          return e.store.startup;
        },
        onChange: (t) => e.setStore("startup", t),
        spellcheck: !1,
        class: "max-h-14 w-full overflow-y-auto font-mono text-xs"
      }), null), r(_, s(I, {
        type: "button",
        variant: "ghost",
        size: "large",
        get onClick() {
          return e.close;
        },
        get children() {
          return a.t("common.cancel");
        }
      }), null), r(_, s(I, {
        type: "submit",
        variant: "primary",
        size: "large",
        get disabled() {
          return e.save.isPending;
        },
        get children() {
          return Q(() => !!e.save.isPending)() ? a.t("common.saving") : a.t("common.save");
        }
      }), null), y((t) => {
        var c = {
          "border-text-interactive-base bg-surface-info-base/20": e.store.dragOver,
          "border-border-base hover:border-border-strong": !e.store.dragOver,
          "overflow-hidden": !!e.store.iconOverride
        }, l = !!(e.store.iconHover && !e.store.iconOverride), o = !(e.store.iconHover && !e.store.iconOverride), i = !!(e.store.iconHover && e.store.iconOverride), n = !(e.store.iconHover && e.store.iconOverride);
        return t.e = P(d, c, t.e), l !== t.t && p.classList.toggle("opacity-100", t.t = l), o !== t.a && p.classList.toggle("opacity-0", t.a = o), i !== t.o && h.classList.toggle("opacity-100", t.o = i), n !== t.i && h.classList.toggle("opacity-0", t.i = n), t;
      }, {
        e: void 0,
        t: void 0,
        a: void 0,
        o: void 0,
        i: void 0
      }), x;
    }
  });
}
Y(["click"]);
export {
  re as DialogEditProject
};
