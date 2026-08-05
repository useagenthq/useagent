import { bI as L, aN as S, aK as H, bm as A, aw as N, at as n, bJ as y, bc as w, b6 as o, bQ as O, bl as D, ad as z, aH as k, bF as _, a2 as R, bL as x, au as Z, bU as q, aR as M, ao as V, b$ as J, ai as m, f as U, h as K, k as Q, d as G, ab as W, H as E, b2 as $, b1 as X, t as Y, o as ee, P as te, e as re, a as T, ba as ae, c as le } from "./skynet-element-dDv65e_D.js";
import { c as ie } from "./edit-project-aAst2tN1.js";
var I = /* @__PURE__ */ x("<div>"), ne = /* @__PURE__ */ x('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path fill-rule=evenodd clip-rule=evenodd d="M13 13H3V3H13V13ZM6.46777 6.81641V7.81641H7.5791V11.3721H8.5791V6.81641H6.46777ZM7.30078 4.62891V5.62891H8.85645V4.62891H7.30078Z"fill=currentColor>'), se = /* @__PURE__ */ x("<label><span data-slot=field-v2-label-text>"), oe = /* @__PURE__ */ x("<button type=button data-slot=field-v2-label-info>");
const B = Z();
function F() {
  const s = q(B);
  if (!s)
    throw new Error("Field subcomponents must be used within <Field>");
  return s;
}
const ce = ["[data-slot='text-input-v2-input']", "[data-slot='textarea-v2-textarea']", "[data-slot='inline-input-v2-input']"].join(", ");
function de(s) {
  const [e, t] = L(s, ["invalid", "class", "classList", "children"]), r = `field-control-${S()}`, l = `field-label-${S()}`, c = `field-prefix-${S()}`, g = `field-suffix-${S()}`, [a, d] = H(0), [u, b] = H(0);
  let p;
  const h = {
    controlId: r,
    labelId: l,
    prefixId: c,
    suffixId: g,
    invalid: () => !!e.invalid,
    registerPrefix: () => d((i) => i + 1),
    unregisterPrefix: () => d((i) => Math.max(0, i - 1)),
    registerSuffix: () => b((i) => i + 1),
    unregisterSuffix: () => b((i) => Math.max(0, i - 1)),
    getDescribedBy: () => {
      const i = [];
      return a() > 0 && i.push(c), u() > 0 && i.push(g), i.length > 0 ? i.join(" ") : void 0;
    }
  }, v = () => {
    const i = p;
    if (!i) return;
    const f = i.querySelector(ce);
    if (!f) return;
    const j = f.closest("[data-component='text-input-v2'], [data-component='textarea-v2'], [data-component='inline-input-v2']");
    f.id = r, f.setAttribute("aria-labelledby", l);
    const C = h.getDescribedBy();
    C ? f.setAttribute("aria-describedby", C) : f.removeAttribute("aria-describedby"), h.invalid() ? (f.setAttribute("aria-invalid", "true"), j?.setAttribute("data-invalid", "")) : (f.removeAttribute("aria-invalid"), j?.removeAttribute("data-invalid"));
  };
  return A(() => {
    v();
  }), N(() => {
    a(), u(), e.invalid, v();
  }), n(B.Provider, {
    value: h,
    get children() {
      var i = I(), f = p;
      return typeof f == "function" ? O(f, i) : p = i, y(i, w(t, {
        "data-component": "field-v2",
        get "data-invalid"() {
          return e.invalid ? "" : void 0;
        },
        get classList() {
          return {
            ...e.classList,
            [e.class ?? ""]: !!e.class
          };
        }
      }), !1, !0), o(i, () => e.children), i;
    }
  });
}
function ue() {
  return ne();
}
function ve(s) {
  const [e, t] = L(s, ["class", "classList", "children", "tooltip"]), r = F();
  return (() => {
    var l = se(), c = l.firstChild;
    return y(l, w(t, {
      get id() {
        return r.labelId;
      },
      get for() {
        return r.controlId;
      },
      "data-slot": "field-v2-label",
      get classList() {
        return {
          ...e.classList,
          [e.class ?? ""]: !!e.class
        };
      }
    }), !1, !0), o(c, () => e.children), o(l, n(R, {
      get when() {
        return e.tooltip;
      },
      children: (g) => n(z, {
        get value() {
          return g();
        },
        get children() {
          var a = oe();
          return a.$$click = (d) => d.stopPropagation(), o(a, n(ue, {})), k(() => _(a, "aria-label", g())), a;
        }
      })
    }), null), l;
  })();
}
function fe(s) {
  const [e, t] = L(s, ["class", "classList", "children"]), r = F();
  return A(() => {
    r.registerPrefix(), D(() => r.unregisterPrefix());
  }), (() => {
    var l = I();
    return y(l, w(t, {
      get id() {
        return r.prefixId;
      },
      "data-slot": "field-v2-prefix",
      get classList() {
        return {
          ...e.classList,
          [e.class ?? ""]: !!e.class
        };
      }
    }), !1, !0), o(l, () => e.children), l;
  })();
}
function ge(s) {
  const [e, t] = L(s, ["class", "classList", "children"]), r = F();
  return A(() => {
    r.registerSuffix(), D(() => r.unregisterSuffix());
  }), (() => {
    var l = I();
    return y(l, w(t, {
      get id() {
        return r.suffixId;
      },
      "data-slot": "field-v2-suffix",
      get classList() {
        return {
          ...e.classList,
          [e.class ?? ""]: !!e.class
        };
      }
    }), !1, !0), o(l, () => e.children), l;
  })();
}
function pe(s) {
  const [e, t] = L(s, ["class", "classList", "children"]);
  return (() => {
    var r = I();
    return y(r, w(t, {
      "data-slot": "field-v2-control",
      get classList() {
        return {
          ...e.classList,
          [e.class ?? ""]: !!e.class
        };
      }
    }), !1, !0), o(r, () => e.children), r;
  })();
}
const xe = Object.assign(de, {
  Label: ve,
  Prefix: fe,
  Suffix: ge,
  Control: pe
}), P = xe;
M(["click"]);
var be = /* @__PURE__ */ x("<div data-component=textarea-v2><textarea>");
function he(s) {
  const [e, t] = L(s, ["class", "classList", "invalid", "disabled", "rows"]);
  return (() => {
    var r = be(), l = r.firstChild;
    return y(l, w(t, {
      get rows() {
        return e.rows ?? 3;
      },
      get disabled() {
        return e.disabled;
      },
      get "aria-invalid"() {
        return e.invalid ? !0 : void 0;
      },
      "data-slot": "textarea-v2-textarea"
    }), !1, !1), k((c) => {
      var g = e.disabled ? "" : void 0, a = e.invalid ? "" : void 0, d = {
        ...e.classList,
        [e.class ?? ""]: !!e.class
      };
      return g !== c.e && _(r, "data-disabled", c.e = g), a !== c.t && _(r, "data-invalid", c.t = a), c.a = V(r, d, c.a), c;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    }), r;
  })();
}
var me = /* @__PURE__ */ x('<div class="flex w-full flex-col gap-2"><div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base"></div><div class="flex items-center gap-3"><button type=button class="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-[6px] outline outline-1 outline-transparent transition-[background-color,outline-color] focus-visible:outline-v2-border-border-focus"><span class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[6px] bg-v2-background-bg-contrast/80 text-v2-icon-icon-contrast backdrop-blur-[2px] transition-opacity"></span></button><input type=file accept=image/* class=hidden><div class="flex select-none flex-col gap-[6px] text-[11px] font-[440] leading-none tracking-[0.05px] text-v2-text-text-muted"><span></span><span>'), $e = /* @__PURE__ */ x('<div class="flex w-full flex-col gap-2"><div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base"></div><div class="-ml-1 flex gap-1.5">'), _e = /* @__PURE__ */ x("<form class=contents>"), Le = /* @__PURE__ */ x('<button type=button class="flex size-8 items-center justify-center rounded-[10px] p-1 outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus">');
function je(s) {
  const e = J(), t = ie(s);
  return n(le, {
    fit: !0,
    get children() {
      var r = _e();
      return m(r, "submit", t.submit), o(r, n(U, {
        get children() {
          return n(K, {
            get children() {
              return e.t("dialog.project.edit.title");
            }
          });
        }
      }), null), o(r, n(Q, {}), null), o(r, n(G, {
        class: "flex max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-6 overflow-y-auto px-4 pt-4 pb-1",
        get children() {
          return [n(P, {
            get children() {
              return [n(P.Label, {
                get children() {
                  return e.t("dialog.project.edit.name");
                }
              }), n(W, {
                autofocus: !0,
                appearance: "large",
                class: "!w-full",
                get value() {
                  return t.store.name;
                },
                get placeholder() {
                  return t.folderName();
                },
                onInput: (l) => t.setStore("name", l.currentTarget.value)
              })];
            }
          }), (() => {
            var l = me(), c = l.firstChild, g = c.nextSibling, a = g.firstChild, d = a.firstChild, u = a.nextSibling, b = u.nextSibling, p = b.firstChild, h = p.nextSibling;
            return o(c, () => e.t("dialog.project.edit.icon")), m(a, "click", t.iconClick, !0), m(a, "dragleave", t.dragLeave), m(a, "dragover", t.dragOver), m(a, "drop", t.drop), a.addEventListener("mouseleave", () => t.setStore("iconHover", !1)), a.addEventListener("mouseenter", () => t.setStore("iconHover", !0)), o(a, n(E, {
              get fallback() {
                return t.store.name || t.defaultName();
              },
              get src() {
                return X(s.project.id, {
                  color: t.store.color,
                  url: s.project.icon?.url,
                  override: t.store.iconOverride
                });
              },
              get variant() {
                return $(t.store.color);
              },
              class: "!size-16 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[32px]"
            }), d), o(d, n(Y, {
              get name() {
                return t.store.iconOverride ? "close" : "outline-share";
              }
            })), m(u, "change", t.inputChange), O((v) => {
              t.setIconInput(v);
            }, u), o(p, () => e.t("dialog.project.edit.icon.hint")), o(h, () => e.t("dialog.project.edit.icon.recommended")), k((v) => {
              var i = e.t("dialog.project.edit.icon.alt"), f = {
                "bg-v2-overlay-simple-overlay-hover outline-v2-border-border-focus": t.store.dragOver
              }, j = !!t.store.iconHover, C = !t.store.iconHover;
              return i !== v.e && _(a, "aria-label", v.e = i), v.t = V(a, f, v.t), j !== v.a && d.classList.toggle("opacity-100", v.a = j), C !== v.o && d.classList.toggle("opacity-0", v.o = C), v;
            }, {
              e: void 0,
              t: void 0,
              a: void 0,
              o: void 0
            }), l;
          })(), n(R, {
            get when() {
              return !t.store.iconOverride;
            },
            get children() {
              var l = $e(), c = l.firstChild, g = c.nextSibling;
              return o(c, () => e.t("dialog.project.edit.color")), o(g, n(ee, {
                each: te,
                children: (a) => (() => {
                  var d = Le();
                  return d.$$click = () => {
                    $(t.store.color) === a && !s.project.icon?.url || t.setStore("color", $(t.store.color) === a ? void 0 : a);
                  }, o(d, n(E, {
                    get fallback() {
                      return t.store.name || t.defaultName();
                    },
                    get variant() {
                      return $(a);
                    },
                    class: "!size-6 [&_[data-slot=project-avatar-surface]]:!rounded-[6px]"
                  })), k((u) => {
                    var b = e.t("dialog.project.edit.color.select", {
                      color: a
                    }), p = $(t.store.color) === a, h = {
                      "bg-v2-overlay-simple-overlay-hover [box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]": $(t.store.color) === a
                    };
                    return b !== u.e && _(d, "aria-label", u.e = b), p !== u.t && _(d, "aria-pressed", u.t = p), u.a = V(d, h, u.a), u;
                  }, {
                    e: void 0,
                    t: void 0,
                    a: void 0
                  }), d;
                })()
              })), l;
            }
          }), n(P, {
            get children() {
              return [n(P.Label, {
                get children() {
                  return e.t("dialog.project.edit.worktree.startup");
                }
              }), n(P.Prefix, {
                get children() {
                  return e.t("dialog.project.edit.worktree.startup.description");
                }
              }), n(he, {
                class: "!w-full [&_[data-slot=textarea-v2-textarea]]:font-mono",
                rows: 3,
                get value() {
                  return t.store.startup;
                },
                get placeholder() {
                  return e.t("dialog.project.edit.worktree.startup.placeholder");
                },
                spellcheck: !1,
                onInput: (l) => t.setStore("startup", l.currentTarget.value)
              })];
            }
          })];
        }
      }), null), o(r, n(re, {
        get children() {
          return [n(T, {
            type: "button",
            variant: "neutral",
            get disabled() {
              return t.save.isPending;
            },
            get onClick() {
              return t.close;
            },
            get children() {
              return e.t("common.cancel");
            }
          }), n(T, {
            type: "submit",
            variant: "contrast",
            get disabled() {
              return t.save.isPending;
            },
            get children() {
              return ae(() => !!t.save.isPending)() ? e.t("common.saving") : e.t("common.save");
            }
          })];
        }
      }), null), r;
    }
  });
}
M(["click"]);
export {
  je as DialogEditProjectV2
};
