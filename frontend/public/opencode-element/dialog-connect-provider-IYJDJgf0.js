import { bI as Xe, bJ as Ye, bc as et, b6 as t, bL as k, bV as Oe, ch as Ue, cg as je, b$ as se, aL as ne, c3 as tt, bG as ke, at as e, N as be, aa as Q, u as he, aH as ve, bF as re, o as pe, B as ae, ba as xe, b as Ve, al as we, by as ue, ck as Ie, j as rt, f as nt, a2 as j, I as De, h as ot, d as it, bQ as Ae, M as O, a5 as ie, c5 as lt, ca as Le, bl as at, aC as A, aI as st, aw as ct, a3 as me, ap as ge, a8 as _e, bw as de, L as Ce, aQ as dt, aN as Ee, bm as fe, ab as Se, a as ze, aR as ut } from "./skynet-element-dDv65e_D.js";
var vt = /* @__PURE__ */ k("<a>");
function le(a) {
  const [K, y] = Xe(a, ["href", "children", "class", "target", "rel"]);
  return (() => {
    var d = vt();
    return Ye(d, et({
      get href() {
        return K.href;
      },
      get class() {
        return `text-text-strong underline ${K.class ?? ""}`;
      },
      get target() {
        return K.target ?? "_blank";
      },
      get rel() {
        return K.rel ?? "noopener noreferrer";
      }
    }, y), !1, !0), t(d, () => K.children), d;
  })();
}
const pt = /^[a-z0-9][a-z0-9-_]*$/, gt = "@ai-sdk/openai-compatible";
function mt(a) {
  const K = a.form.providerID.trim(), y = a.form.name.trim(), d = a.form.baseURL.trim(), c = a.form.apiKey.trim(), n = c.match(/^\{env:([^}]+)\}$/)?.[1]?.trim(), R = c && !n ? c : void 0, C = K ? pt.test(K) ? void 0 : a.t("provider.custom.error.providerID.format") : a.t("provider.custom.error.providerID.required"), g = y ? void 0 : a.t("provider.custom.error.name.required"), S = d ? /^https?:\/\//.test(d) ? void 0 : a.t("provider.custom.error.baseURL.format") : a.t("provider.custom.error.baseURL.required"), F = a.disabledProviders.includes(K), P = C ? void 0 : a.existingProviderIDs.has(K) && !F ? a.t("provider.custom.error.providerID.exists") : void 0, $ = /* @__PURE__ */ new Set(), I = a.form.models.map((h) => {
    const U = h.id.trim(), q = U ? $.has(U) ? a.t("provider.custom.error.duplicate") : (() => {
      $.add(U);
    })() : a.t("provider.custom.error.required"), E = h.name.trim() ? void 0 : a.t("provider.custom.error.required");
    return { id: q, name: E };
  }), Y = I.every((h) => !h.id && !h.name), J = Object.fromEntries(a.form.models.map((h) => [h.id.trim(), { name: h.name.trim() }])), w = /* @__PURE__ */ new Set(), i = a.form.headers.map((h) => {
    const U = h.key.trim(), q = h.value.trim();
    if (!U && !q) return {};
    const E = U ? w.has(U.toLowerCase()) ? a.t("provider.custom.error.duplicate") : (() => {
      w.add(U.toLowerCase());
    })() : a.t("provider.custom.error.required"), ee = q ? void 0 : a.t("provider.custom.error.required");
    return { key: E, value: ee };
  }), l = i.every((h) => !h.key && !h.value), M = Object.fromEntries(
    a.form.headers.map((h) => ({ key: h.key.trim(), value: h.value.trim() })).filter((h) => !!h.key && !!h.value).map((h) => [h.key, h.value])
  ), B = {
    providerID: C ?? P,
    name: g,
    baseURL: S
  };
  return !C && !P && !g && !S && Y && l ? {
    err: B,
    models: I,
    headers: i,
    result: {
      providerID: K,
      name: y,
      key: R,
      config: {
        npm: gt,
        name: y,
        ...n ? { env: [n] } : {},
        options: {
          baseURL: d,
          ...Object.keys(M).length ? { headers: M } : {}
        },
        models: J
      }
    }
  } : { err: B, models: I, headers: i };
}
let ft = 0;
const Ze = () => `row-${ft++}`, Ke = () => ({ row: Ze(), id: "", name: "", err: {} }), Re = () => ({ row: Ze(), key: "", value: "", err: {} });
var ht = /* @__PURE__ */ k('<div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]"><div class="px-2.5 flex gap-4 items-center"><div class="text-16-medium text-text-strong"></div></div><form class="px-2.5 pb-6 flex flex-col gap-6"><p class="text-14-regular text-text-base"></p><div class="flex flex-col gap-4"></div><div class="flex flex-col gap-3"><label class="text-12-medium text-text-weak"></label></div><div class="flex flex-col gap-3"><label class="text-12-medium text-text-weak">'), Me = /* @__PURE__ */ k('<div class="flex gap-2 items-start"><div class=flex-1></div><div class=flex-1>');
function Gt(a) {
  const K = se();
  return e(Ve, {
    class: "h-full",
    get title() {
      return e(he, {
        tabIndex: -1,
        icon: "arrow-left",
        variant: "ghost",
        get onClick() {
          return a.onBack;
        },
        get "aria-label"() {
          return K.t("common.goBack");
        }
      });
    },
    transition: !0,
    get children() {
      return e(He, {});
    }
  });
}
function He(a = {}) {
  const K = Oe(), y = Ue(), d = je(), c = se(), [n, R] = ne({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [Ke()],
    headers: [Re()],
    err: {}
  }), C = () => {
    R("models", ue((i) => {
      i.push(Ke());
    }));
  }, g = (i) => {
    n.models.length <= 1 || R("models", ue((l) => {
      l.splice(i, 1);
    }));
  }, S = () => {
    R("headers", ue((i) => {
      i.push(Re());
    }));
  }, F = (i) => {
    n.headers.length <= 1 || R("headers", ue((l) => {
      l.splice(i, 1);
    }));
  }, P = (i, l) => {
    R(i, l), i !== "apiKey" && R("err", i, void 0);
  }, $ = (i, l, M) => {
    we(() => {
      R("models", i, l, M), R("models", i, "err", l, void 0);
    });
  }, I = (i, l, M) => {
    we(() => {
      R("headers", i, l, M), R("headers", i, "err", l, void 0);
    });
  }, Y = () => {
    const i = mt({
      form: n,
      t: c.t,
      disabledProviders: y().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(y().data.provider.all.keys())
    });
    return we(() => {
      R("err", i.err), i.models.forEach((l, M) => R("models", M, "err", l)), i.headers.forEach((l, M) => R("headers", M, "err", l));
    }), i.result;
  }, J = tt(() => ({
    mutationFn: async (i) => {
      if (await d().protocol !== "v1") throw new Error(c.t("provider.custom.unavailable"));
      const M = (y().data.config.disabled_providers ?? []).filter((B) => B !== i.providerID);
      return i.key && await d().client.auth.set({
        providerID: i.providerID,
        auth: {
          type: "api",
          key: i.key
        }
      }), await y().updateConfig({
        provider: {
          [i.providerID]: i.config
        },
        disabled_providers: M
      }), i;
    },
    onSuccess: (i) => {
      K.close(), ke({
        variant: "success",
        icon: "circle-check",
        title: c.t("provider.connect.toast.connected.title", {
          provider: i.name
        }),
        description: c.t("provider.connect.toast.connected.description", {
          provider: i.name
        })
      });
    },
    onError: (i) => {
      const l = i instanceof Error ? i.message : String(i);
      ke({
        title: c.t("common.requestFailed"),
        description: l
      });
    }
  })), w = (i) => {
    if (i.preventDefault(), J.isPending) return;
    const l = Y();
    l && J.mutate(l);
  };
  return (() => {
    var i = ht(), l = i.firstChild, M = l.firstChild, B = l.nextSibling, L = B.firstChild, h = L.nextSibling, U = h.nextSibling, q = U.firstChild, E = U.nextSibling, ee = E.firstChild;
    return t(l, e(be, {
      id: "synthetic",
      class: "size-5 shrink-0 icon-strong-base"
    }), M), t(M, () => c.t("provider.custom.title")), B.addEventListener("submit", w), t(L, () => c.t("provider.custom.description.prefix"), null), t(L, e(le, {
      href: "https://opencode.ai/docs/providers/#custom-provider",
      tabIndex: -1,
      get children() {
        return c.t("provider.custom.description.link");
      }
    }), null), t(L, () => c.t("provider.custom.description.suffix"), null), t(h, e(Q, {
      get autofocus() {
        return a.autofocus ?? !0;
      },
      get label() {
        return c.t("provider.custom.field.providerID.label");
      },
      get placeholder() {
        return c.t("provider.custom.field.providerID.placeholder");
      },
      get description() {
        return c.t("provider.custom.field.providerID.description");
      },
      get value() {
        return n.providerID;
      },
      onChange: (v) => P("providerID", v),
      get validationState() {
        return n.err.providerID ? "invalid" : void 0;
      },
      get error() {
        return n.err.providerID;
      }
    }), null), t(h, e(Q, {
      get label() {
        return c.t("provider.custom.field.name.label");
      },
      get placeholder() {
        return c.t("provider.custom.field.name.placeholder");
      },
      get value() {
        return n.name;
      },
      onChange: (v) => P("name", v),
      get validationState() {
        return n.err.name ? "invalid" : void 0;
      },
      get error() {
        return n.err.name;
      }
    }), null), t(h, e(Q, {
      get label() {
        return c.t("provider.custom.field.baseURL.label");
      },
      get placeholder() {
        return c.t("provider.custom.field.baseURL.placeholder");
      },
      get value() {
        return n.baseURL;
      },
      onChange: (v) => P("baseURL", v),
      get validationState() {
        return n.err.baseURL ? "invalid" : void 0;
      },
      get error() {
        return n.err.baseURL;
      }
    }), null), t(h, e(Q, {
      get label() {
        return c.t("provider.custom.field.apiKey.label");
      },
      get placeholder() {
        return c.t("provider.custom.field.apiKey.placeholder");
      },
      get description() {
        return c.t("provider.custom.field.apiKey.description");
      },
      get value() {
        return n.apiKey;
      },
      onChange: (v) => P("apiKey", v)
    }), null), t(q, () => c.t("provider.custom.models.label")), t(U, e(pe, {
      get each() {
        return n.models;
      },
      children: (v, H) => (() => {
        var V = Me(), G = V.firstChild, te = G.nextSibling;
        return t(G, e(Q, {
          get label() {
            return c.t("provider.custom.models.id.label");
          },
          hideLabel: !0,
          get placeholder() {
            return c.t("provider.custom.models.id.placeholder");
          },
          get value() {
            return v.id;
          },
          onChange: (X) => $(H(), "id", X),
          get validationState() {
            return v.err.id ? "invalid" : void 0;
          },
          get error() {
            return v.err.id;
          }
        })), t(te, e(Q, {
          get label() {
            return c.t("provider.custom.models.name.label");
          },
          hideLabel: !0,
          get placeholder() {
            return c.t("provider.custom.models.name.placeholder");
          },
          get value() {
            return v.name;
          },
          onChange: (X) => $(H(), "name", X),
          get validationState() {
            return v.err.name ? "invalid" : void 0;
          },
          get error() {
            return v.err.name;
          }
        })), t(V, e(he, {
          type: "button",
          icon: "trash",
          variant: "ghost",
          class: "mt-1.5",
          onClick: () => g(H()),
          get disabled() {
            return n.models.length <= 1;
          },
          get "aria-label"() {
            return c.t("provider.custom.models.remove");
          }
        }), null), ve(() => re(V, "data-row", v.row)), V;
      })()
    }), null), t(U, e(ae, {
      type: "button",
      size: "small",
      variant: "ghost",
      icon: "plus-small",
      onClick: C,
      class: "self-start",
      get children() {
        return c.t("provider.custom.models.add");
      }
    }), null), t(ee, () => c.t("provider.custom.headers.label")), t(E, e(pe, {
      get each() {
        return n.headers;
      },
      children: (v, H) => (() => {
        var V = Me(), G = V.firstChild, te = G.nextSibling;
        return t(G, e(Q, {
          get label() {
            return c.t("provider.custom.headers.key.label");
          },
          hideLabel: !0,
          get placeholder() {
            return c.t("provider.custom.headers.key.placeholder");
          },
          get value() {
            return v.key;
          },
          onChange: (X) => I(H(), "key", X),
          get validationState() {
            return v.err.key ? "invalid" : void 0;
          },
          get error() {
            return v.err.key;
          }
        })), t(te, e(Q, {
          get label() {
            return c.t("provider.custom.headers.value.label");
          },
          hideLabel: !0,
          get placeholder() {
            return c.t("provider.custom.headers.value.placeholder");
          },
          get value() {
            return v.value;
          },
          onChange: (X) => I(H(), "value", X),
          get validationState() {
            return v.err.value ? "invalid" : void 0;
          },
          get error() {
            return v.err.value;
          }
        })), t(V, e(he, {
          type: "button",
          icon: "trash",
          variant: "ghost",
          class: "mt-1.5",
          onClick: () => F(H()),
          get disabled() {
            return n.headers.length <= 1;
          },
          get "aria-label"() {
            return c.t("provider.custom.headers.remove");
          }
        }), null), ve(() => re(V, "data-row", v.row)), V;
      })()
    }), null), t(E, e(ae, {
      type: "button",
      size: "small",
      variant: "ghost",
      icon: "plus-small",
      onClick: S,
      class: "self-start",
      get children() {
        return c.t("provider.custom.headers.add");
      }
    }), null), t(B, e(ae, {
      class: "w-auto self-start",
      type: "submit",
      size: "large",
      variant: "primary",
      get disabled() {
        return J.isPending;
      },
      get children() {
        return xe(() => !!J.isPending)() ? c.t("common.saving") : c.t("common.submit");
      }
    }), null), i;
  })();
}
var xt = /* @__PURE__ */ k('<button type=button class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none">'), bt = /* @__PURE__ */ k('<div tabindex=-1 class="flex min-h-0 flex-1 flex-col outline-none">'), Be = /* @__PURE__ */ k('<div class="text-14-regular text-text-weak">'), yt = /* @__PURE__ */ k('<div class="px-1.25 w-full flex items-center gap-x-3"><span>'), wt = /* @__PURE__ */ k('<div class="flex h-24 items-center justify-center text-[13px] font-[440] text-v2-text-text-muted">'), _t = /* @__PURE__ */ k('<div class="flex min-h-0 flex-1 flex-col gap-4"><div class="shrink-0 px-1 pt-px"></div><div class="relative min-h-0 flex-1"><div class="flex size-full min-h-0 flex-col gap-4 overflow-y-auto pb-8 [scrollbar-width:none] [&amp;::-webkit-scrollbar]:hidden"></div><div class="pointer-events-none absolute inset-x-0 bottom-0 h-10"style="background:linear-gradient(to bottom, transparent, var(--v2-background-bg-layer-01))">'), $t = /* @__PURE__ */ k('<section class="flex flex-col"><div class="px-3 pb-2 text-[13px] font-[440] leading-none tracking-[-0.04px] text-v2-text-text-muted">'), kt = /* @__PURE__ */ k('<span class="min-w-0 truncate font-[440] text-v2-text-text-muted">'), qe = /* @__PURE__ */ k('<span class="flex h-4 shrink-0 items-center rounded-xs border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-03 px-1 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-text-text-muted">'), Ct = /* @__PURE__ */ k('<button type=button class="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[13px] leading-none tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"><span class="min-w-0 truncate font-[530] text-v2-text-text-base">'), St = /* @__PURE__ */ k('<div class="w-full flex flex-col gap-1.5"><div class="text-14-regular text-text-base"></div><div>'), It = /* @__PURE__ */ k('<form class="flex flex-col items-start gap-4">'), Dt = /* @__PURE__ */ k('<div class="w-full flex items-center gap-x-2"><div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center"><div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden"data-slot=list-item-extra-icon></div></div><span></span><span class="text-14-regular text-text-weak">'), Lt = /* @__PURE__ */ k('<div class="flex flex-col gap-2"><div class="px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted"></div><div class="flex flex-col">'), Pt = /* @__PURE__ */ k('<button type=button class="group flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] leading-5 tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"><span class="flex h-2 w-4 shrink-0 items-center justify-center rounded-[1px] bg-v2-background-bg-base shadow-[var(--v2-elevation-button-neutral)]"><span class="hidden h-0.5 w-2.5 bg-v2-icon-icon-base group-hover:block group-focus-visible:block"></span></span><span class="font-[530] text-v2-text-text-base">'), Et = /* @__PURE__ */ k('<span class="font-[440] text-v2-text-text-muted">'), Fe = /* @__PURE__ */ k('<div class="text-14-regular text-text-base">'), zt = /* @__PURE__ */ k("<div>"), Kt = /* @__PURE__ */ k('<div class="w-full flex items-center gap-x-2"><div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center"><div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden"data-slot=list-item-extra-icon></div></div><span>'), Rt = /* @__PURE__ */ k('<div class="flex flex-col gap-5"><div></div><div></div><div>'), Mt = /* @__PURE__ */ k('<div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted"><form class="flex flex-col items-start gap-5 self-stretch"><label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">'), Te = /* @__PURE__ */ k('<div role=alert class="-mt-4 text-xs text-v2-state-fg-danger">'), Bt = /* @__PURE__ */ k('<div class="flex flex-col gap-4"><div class="text-14-regular text-text-base"></div><div class="text-14-regular text-text-base"></div><div class="text-14-regular text-text-base">'), qt = /* @__PURE__ */ k('<div class="flex flex-col gap-6"><form class="flex flex-col items-start gap-4">'), Ft = /* @__PURE__ */ k('<div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted"><div></div><form class="flex flex-col items-start gap-5 self-stretch"><label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">'), Tt = /* @__PURE__ */ k('<div class="flex flex-col gap-6"><div class="text-14-regular text-text-base"></div><form class="flex flex-col items-start gap-4">'), Ot = /* @__PURE__ */ k('<div class="flex flex-col gap-6"><div class="text-14-regular text-text-base"></div><div class="text-14-regular text-text-base flex items-center gap-4"><span>'), $e = /* @__PURE__ */ k('<div class="text-14-regular text-text-base"><div class="flex items-center gap-x-2"><span>'), Ut = /* @__PURE__ */ k("<div><div><div></div></div><div><div>");
const W = "_custom";
function Ge(a = {}) {
  const [K, y] = ne({
    selected: void 0
  }), d = () => y("selected", void 0);
  return {
    selected: () => K.selected,
    select: (c) => y("selected", c),
    back: a.onBack ?? d
  };
}
const jt = (a) => {
  const K = Ge(), y = a.controller ?? K, d = se(), n = Ie().general.newLayoutDesigns, R = y.back, C = {
    current: R
  };
  let g;
  const S = () => g?.focus({
    preventScroll: !0
  }), F = ($) => {
    C.current = R, y.select($);
  };
  function P() {
    return e(ie, {
      get children() {
        return [e(O, {
          get when() {
            return y.selected() === W;
          },
          get children() {
            return e(He, {
              get autofocus() {
                return !n();
              }
            });
          }
        }), e(O, {
          get when() {
            return xe(() => !!(y.selected() && y.selected() !== W))() ? y.selected() : void 0;
          },
          children: ($) => e(Zt, {
            get provider() {
              return $();
            },
            get directory() {
              return a.directory;
            },
            onBack: R,
            setBack: (I) => C.current = I
          })
        }), e(O, {
          when: !0,
          get children() {
            return e(Vt, {
              get directory() {
                return a.directory;
              },
              onSelect: F,
              get onPrepare() {
                return n() ? S : void 0;
              }
            });
          }
        })];
      }
    });
  }
  return e(j, {
    get when() {
      return n();
    },
    get fallback() {
      return e(Ve, {
        class: "h-full",
        transition: !0,
        get title() {
          return e(j, {
            get when() {
              return y.selected();
            },
            get fallback() {
              return d.t("command.provider.connect");
            },
            get children() {
              return e(he, {
                tabIndex: -1,
                icon: "arrow-left",
                variant: "ghost",
                onClick: () => C.current(),
                get "aria-label"() {
                  return d.t("common.goBack");
                }
              });
            }
          });
        },
        get children() {
          return e(P, {});
        }
      });
    },
    get children() {
      return e(rt, {
        containerClass: "!h-[min(calc(100vh_-_16px),512px)] !w-[min(calc(100vw_-_16px),640px)]",
        class: "[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]",
        get children() {
          return [e(nt, {
            get closeLabel() {
              return d.t("common.close");
            },
            get children() {
              return e(j, {
                get when() {
                  return y.selected();
                },
                get fallback() {
                  return e(ot, {
                    get children() {
                      return d.t("command.provider.connect");
                    }
                  });
                },
                get children() {
                  var $ = xt();
                  return $.$$click = () => C.current(), t($, e(De, {
                    name: "arrow-left",
                    size: "small"
                  })), ve(() => re($, "aria-label", d.t("common.goBack"))), $;
                }
              });
            }
          }), e(it, {
            class: "min-h-0 flex-1 overflow-hidden px-2 pb-2",
            get children() {
              var $ = bt(), I = g;
              return typeof I == "function" ? Ae(I, $) : g = $, t($, e(P, {})), $;
            }
          })];
        }
      });
    }
  });
};
function Vt(a) {
  if (Ie().general.newLayoutDesigns()) return e(At, {
    get directory() {
      return a.directory;
    },
    get onSelect() {
      return a.onSelect;
    },
    get onPrepare() {
      return a.onPrepare;
    }
  });
  const y = Le(() => a.directory?.()), d = se(), c = () => d.t("dialog.provider.group.popular"), n = () => d.t("dialog.provider.group.other"), R = () => d.t("settings.providers.tag.custom"), C = (g) => {
    if (g === "anthropic") return d.t("dialog.provider.anthropic.note");
    if (g === "openai") return d.t("dialog.provider.openai.note");
    if (g.startsWith("github-copilot")) return d.t("dialog.provider.copilot.note");
    if (g === "opencode-go") return d.t("dialog.provider.opencodeGo.tagline");
  };
  return e(Ce, {
    class: "px-3",
    get search() {
      return {
        placeholder: d.t("dialog.provider.search.placeholder"),
        autofocus: !0
      };
    },
    get emptyMessage() {
      return d.t("dialog.provider.empty");
    },
    activeIcon: "plus-small",
    key: (g) => g?.id,
    items: () => (d.locale(), [{
      id: W,
      name: R()
    }, ...y.all().values()]),
    filterKeys: ["id", "name"],
    groupBy: (g) => de.includes(g.id) ? c() : n(),
    sortBy: (g, S) => g.id === W ? -1 : S.id === W ? 1 : de.includes(g.id) && de.includes(S.id) ? de.indexOf(g.id) - de.indexOf(S.id) : g.name.localeCompare(S.name),
    sortGroupsBy: (g, S) => {
      const F = c();
      return g.category === F && S.category !== F ? -1 : S.category === F && g.category !== F ? 1 : 0;
    },
    onSelect: (g) => {
      g && a.onSelect(g.id);
    },
    children: (g) => (() => {
      var S = yt(), F = S.firstChild;
      return t(S, e(be, {
        "data-slot": "list-item-extra-icon",
        get id() {
          return g.id;
        }
      }), F), t(F, () => g.name), t(S, e(j, {
        get when() {
          return g.id === "opencode";
        },
        get children() {
          var P = Be();
          return t(P, () => d.t("dialog.provider.opencode.tagline")), P;
        }
      }), null), t(S, e(j, {
        get when() {
          return g.id === W;
        },
        get children() {
          return e(_e, {
            get children() {
              return d.t("settings.providers.tag.custom");
            }
          });
        }
      }), null), t(S, e(j, {
        get when() {
          return g.id === "opencode";
        },
        get children() {
          return e(_e, {
            get children() {
              return d.t("dialog.provider.tag.recommended");
            }
          });
        }
      }), null), t(S, e(j, {
        get when() {
          return C(g.id);
        },
        children: (P) => (() => {
          var $ = Be();
          return t($, P), $;
        })()
      }), null), t(S, e(j, {
        get when() {
          return g.id === "opencode-go";
        },
        get children() {
          return e(_e, {
            get children() {
              return d.t("dialog.provider.tag.recommended");
            }
          });
        }
      }), null), S;
    })()
  });
}
function At(a) {
  const K = Le(() => a.directory?.()), y = se(), [d, c] = ne({
    filter: "",
    active: void 0,
    connecting: void 0
  }), n = ["opencode", "opencode-go", "anthropic", "openai", "google", "openrouter", "vercel"], R = () => ({
    id: W,
    name: y.t("dialog.provider.custom.label")
  }), C = A(() => {
    y.locale();
    const w = d.filter.trim().toLowerCase(), i = [R(), ...K.all().values()];
    return w ? i.filter((l) => `${l.id} ${l.name}`.toLowerCase().includes(w)) : i;
  }), g = A(() => C().filter((w) => n.includes(w.id)).sort((w, i) => n.indexOf(w.id) - n.indexOf(i.id))), S = A(() => C().filter((w) => !n.includes(w.id)).sort((w, i) => w.id === W ? -1 : i.id === W ? 1 : w.name.localeCompare(i.name))), F = A(() => [...g(), ...S()]);
  let P, $;
  fe(() => $?.focus({
    preventScroll: !0
  }));
  const I = (w) => {
    a.onPrepare?.(), a.onSelect(w);
  }, Y = (w, i) => {
    const l = F();
    if (l.length === 0) return;
    const M = l.findIndex((L) => L.id === d.active), B = M < 0 ? i > 0 ? 0 : l.length - 1 : (M + i + l.length) % l.length;
    c("active", l[B].id), P?.querySelector(`[data-provider-id="${CSS.escape(l[B].id)}"]`)?.focus({
      preventScroll: !0
    }), w.preventDefault();
  }, J = (w) => {
    if (w.key === "ArrowDown") return Y(w, 1);
    if (w.key === "ArrowUp") return Y(w, -1);
    w.key !== "Enter" || !d.active || (I(d.active), w.preventDefault());
  };
  return (() => {
    var w = _t(), i = w.firstChild, l = i.nextSibling, M = l.firstChild;
    M.nextSibling, w.$$keydown = J;
    var B = P;
    return typeof B == "function" ? Ae(B, w) : P = w, t(i, e(Se, {
      ref(L) {
        var h = $;
        typeof h == "function" ? h(L) : $ = L;
      },
      type: "search",
      class: "!w-full [font-family:var(--v2-font-family-sans)]",
      get leadingIcon() {
        return e(De, {
          name: "magnifying-glass",
          size: "small"
        });
      },
      get placeholder() {
        return y.t("dialog.provider.search.placeholder");
      },
      get value() {
        return d.filter;
      },
      onInput: (L) => {
        c({
          filter: L.currentTarget.value,
          active: void 0
        });
      }
    })), t(M, e(pe, {
      get each() {
        return [{
          title: y.t("dialog.provider.group.popular"),
          items: g
        }, {
          title: y.t("dialog.provider.group.other"),
          items: S
        }];
      },
      children: (L) => e(j, {
        get when() {
          return L.items().length > 0;
        },
        get children() {
          var h = $t(), U = h.firstChild;
          return t(U, () => L.title), t(h, e(pe, {
            get each() {
              return L.items();
            },
            children: (q) => (() => {
              var E = Ct(), ee = E.firstChild;
              return E.$$click = () => I(q.id), E.addEventListener("mouseenter", () => c("active", q.id)), t(E, e(be, {
                get id() {
                  return q.id;
                },
                class: "size-4 shrink-0 text-v2-icon-icon-base"
              }), ee), t(ee, () => q.name), t(E, e(j, {
                get when() {
                  return q.id === "opencode" || q.id === "opencode-go";
                },
                get children() {
                  return [(() => {
                    var v = kt();
                    return t(v, () => y.t(q.id === "opencode" ? "dialog.provider.opencode.tagline" : "dialog.provider.opencodeGo.tagline")), v;
                  })(), (() => {
                    var v = qe();
                    return t(v, () => y.t("dialog.provider.tag.recommended")), v;
                  })()];
                }
              }), null), t(E, e(j, {
                get when() {
                  return q.id === W;
                },
                get children() {
                  var v = qe();
                  return t(v, () => y.t("settings.providers.tag.custom")), v;
                }
              }), null), t(E, e(j, {
                get when() {
                  return d.connecting === q.id;
                },
                get children() {
                  return e(me, {
                    class: "ml-auto size-4 shrink-0 text-v2-icon-icon-muted"
                  });
                }
              }), null), ve((v) => {
                var H = q.id, V = d.active === q.id, G = d.connecting !== void 0, te = d.connecting === q.id;
                return H !== v.e && re(E, "data-provider-id", v.e = H), V !== v.t && E.classList.toggle("bg-v2-overlay-simple-overlay-hover", v.t = V), G !== v.a && (E.disabled = v.a = G), te !== v.o && re(E, "aria-busy", v.o = te), v;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0
              }), E;
            })()
          }), null), h;
        }
      })
    }), null), t(M, e(j, {
      get when() {
        return F().length === 0;
      },
      get children() {
        var L = wt();
        return t(L, () => y.t("dialog.provider.empty")), L;
      }
    }), null), w;
  })();
}
function Zt(a) {
  const K = Oe(), y = Ue(), d = je(), c = lt(), n = se(), C = Ie().general.newLayoutDesigns, g = Le(() => a.directory?.()), S = () => a.directory?.() ?? dt(c.dir), F = () => {
    const r = S();
    return r ? {
      directory: r
    } : void 0;
  }, P = {
    value: !0
  }, $ = {
    current: void 0
  };
  at(() => {
    P.value = !1, $.current !== void 0 && (clearTimeout($.current), $.current = void 0);
  });
  const I = A(() => g.all().get(a.provider) ?? y().data.provider.all.get(a.provider)), Y = A(() => [{
    type: "key",
    label: n.t("provider.connect.method.apiKey")
  }]), [J] = st(() => ({
    provider: a.provider,
    directory: S()
  }), (r) => d().api.integration.get({
    integrationID: r.provider,
    location: r.directory ? {
      directory: r.directory
    } : void 0
  }).then((o) => o.data)), w = A(() => J.loading), i = A(() => {
    const r = J.latest?.methods.filter((o) => o.type === "key" || o.type === "oauth");
    return r?.length ? r : Y();
  }), [l, M] = ne({
    methodIndex: void 0,
    authorization: void 0,
    promptInputs: void 0,
    state: "pending",
    error: void 0
  });
  function B(r) {
    M(ue((o) => {
      if (r.type === "method.select") {
        o.methodIndex = r.index, o.authorization = void 0, o.promptInputs = void 0, o.state = void 0, o.error = void 0;
        return;
      }
      if (r.type === "method.reset") {
        o.methodIndex = void 0, o.authorization = void 0, o.promptInputs = void 0, o.state = void 0, o.error = void 0;
        return;
      }
      if (r.type === "auth.prompt") {
        o.state = "prompt", o.error = void 0;
        return;
      }
      if (r.type === "auth.inputs") {
        o.promptInputs = r.inputs, o.state = void 0, o.error = void 0;
        return;
      }
      if (r.type === "auth.pending") {
        o.state = "pending", o.error = void 0;
        return;
      }
      if (r.type === "auth.complete") {
        o.state = "complete", o.authorization = r.authorization, o.error = void 0;
        return;
      }
      o.state = "error", o.error = r.error;
    }));
  }
  const L = A(() => l.methodIndex !== void 0 ? i().at(l.methodIndex) : void 0), h = (r) => r ? r.type === "key" ? n.t("provider.connect.method.apiKey") : r.label ?? "" : "", U = (r) => {
    const o = h(r), s = r?.label?.match(/\s+\((browser|headless)\)$/i), x = s?.[1];
    return {
      label: s ? o.slice(0, -s[0].length) : o,
      hint: x?.toLowerCase() === "headless" ? n.t("provider.connect.method.headless") : x?.toLowerCase() === "browser" || !x && r?.type === "key" ? n.t("provider.connect.method.browser") : void 0
    };
  };
  function q(r, o) {
    if (r && typeof r == "object" && "data" in r) {
      const s = r.data;
      if (typeof s?.message == "string" && s.message) return s.message;
    }
    if (r && typeof r == "object" && "error" in r) {
      const s = q(r.error, "");
      if (s) return s;
    }
    if (r && typeof r == "object" && "message" in r) {
      const s = r.message;
      if (typeof s == "string" && s) return s;
    }
    return r instanceof Error && r.message ? r.message : typeof r == "string" && r ? r : o;
  }
  async function E(r, o) {
    $.current !== void 0 && (clearTimeout($.current), $.current = void 0);
    const s = i()[r];
    if (B({
      type: "method.select",
      index: r
    }), s.type === "oauth") {
      if (s.prompts?.length && !o) {
        B({
          type: "auth.prompt"
        });
        return;
      }
      B({
        type: "auth.pending"
      }), await d().api.integration.oauth.connect({
        integrationID: a.provider,
        methodID: s.id,
        inputs: o ?? {},
        location: F()
      }).then((x) => {
        P.value && B({
          type: "auth.complete",
          authorization: x.data
        });
      }).catch((x) => {
        P.value && B({
          type: "auth.error",
          error: q(x, n.t("common.requestFailed"))
        });
      });
    }
  }
  function ee() {
    const [r, o] = ne({
      value: {},
      index: 0
    }), s = A(() => {
      const b = L();
      return b?.type === "oauth" ? b.prompts ?? [] : [];
    }), x = (b, T) => {
      if (!b.when) return !0;
      const Z = T[b.when.key];
      return Z === void 0 ? !1 : b.when.op === "eq" ? Z === b.when.value : Z !== b.when.value;
    }, z = A(() => {
      const b = s(), T = b.findIndex((Z, ce) => ce >= r.index && x(Z, r.value));
      if (T !== -1)
        return {
          index: T,
          prompt: b[T]
        };
    }), u = A(() => {
      const b = z();
      return !b || b.prompt.type !== "text" ? !1 : (r.value[b.prompt.key] ?? "").trim().length > 0;
    });
    async function p(b, T) {
      if (l.methodIndex === void 0) return;
      const Z = s().findIndex((ce, N) => N > b && x(ce, T));
      if (Z !== -1) {
        o("index", Z);
        return;
      }
      await E(l.methodIndex, T);
    }
    async function m(b) {
      b.preventDefault();
      const T = z();
      !T || T.prompt.type !== "text" || u() && await p(T.index, r.value);
    }
    const f = () => z(), _ = A(() => {
      const b = f()?.prompt;
      if (!(!b || b.type !== "text"))
        return b;
    }), D = A(() => {
      const b = f()?.prompt;
      if (!(!b || b.type !== "select"))
        return b;
    });
    return (() => {
      var b = It();
      return b.addEventListener("submit", m), t(b, e(ie, {
        get children() {
          return [e(O, {
            get when() {
              return f()?.prompt.type === "text";
            },
            get children() {
              return [e(Q, {
                type: "text",
                get label() {
                  return _()?.message ?? "";
                },
                get placeholder() {
                  return _()?.placeholder;
                },
                get value() {
                  return xe(() => !!_())() ? r.value[_().key] ?? "" : "";
                },
                onChange: (T) => {
                  const Z = _();
                  Z && o("value", Z.key, T);
                }
              }), e(ae, {
                class: "w-auto",
                type: "submit",
                size: "large",
                variant: "primary",
                get disabled() {
                  return !u();
                },
                get children() {
                  return n.t("common.continue");
                }
              })];
            }
          }), e(O, {
            get when() {
              return f()?.prompt.type === "select";
            },
            get children() {
              var T = St(), Z = T.firstChild, ce = Z.nextSibling;
              return t(Z, () => D()?.message), t(ce, e(Ce, {
                class: "px-3",
                get items() {
                  return D()?.options ?? [];
                },
                key: (N) => N.value,
                get current() {
                  return D()?.options.find((N) => N.value === r.value[D().key]);
                },
                onSelect: (N) => {
                  if (!N) return;
                  const oe = D();
                  if (!oe) return;
                  const ye = {
                    ...r.value,
                    [oe.key]: N.value
                  };
                  o("value", oe.key, N.value), p(f().index, ye);
                },
                children: (N) => (() => {
                  var oe = Dt(), ye = oe.firstChild, Pe = ye.nextSibling, We = Pe.nextSibling;
                  return t(Pe, () => N.label), t(We, () => N.hint), oe;
                })()
              })), T;
            }
          })];
        }
      })), b;
    })();
  }
  let v;
  function H(r) {
    r.key === "Enter" && r.target instanceof HTMLInputElement || r.key !== "Escape" && v?.onKeyDown(r);
  }
  let V = !1;
  ct(() => {
    V || w() || i().length === 1 && (V = !0, E(0));
  });
  async function G() {
    await y().refreshProviders().catch(() => {
    }), K.close(), ke({
      variant: "success",
      icon: "circle-check",
      title: n.t("provider.connect.toast.connected.title", {
        provider: I().name
      }),
      description: n.t("provider.connect.toast.connected.description", {
        provider: I().name
      })
    });
  }
  function te() {
    if (i().length > 1 && l.methodIndex !== void 0) {
      B({
        type: "method.reset"
      });
      return;
    }
    a.onBack();
  }
  a.setBack(te);
  function X() {
    return C() ? (() => {
      var r = Lt(), o = r.firstChild, s = o.nextSibling;
      return t(o, () => n.t("provider.connect.selectMethod", {
        provider: I().name
      })), t(s, e(pe, {
        get each() {
          return i();
        },
        children: (x, z) => {
          const u = () => U(x);
          return (() => {
            var p = Pt(), m = p.firstChild, f = m.nextSibling;
            return p.$$click = () => void E(z()), t(f, () => u().label), t(p, e(j, {
              get when() {
                return u().hint;
              },
              children: (_) => (() => {
                var D = Et();
                return t(D, _), D;
              })()
            }), null), p;
          })();
        }
      })), r;
    })() : [(() => {
      var r = Fe();
      return t(r, () => n.t("provider.connect.selectMethod", {
        provider: I().name
      })), r;
    })(), (() => {
      var r = zt();
      return t(r, e(Ce, {
        class: "px-3",
        ref: (o) => {
          v = o;
        },
        items: i,
        key: (o) => o?.label ?? o?.type,
        onSelect: async (o, s) => {
          o && E(s);
        },
        children: (o) => (() => {
          var s = Kt(), x = s.firstChild, z = x.nextSibling;
          return t(z, () => h(o)), s;
        })()
      })), r;
    })()];
  }
  function Ne() {
    let r;
    const o = Ee(), [s, x] = ne({
      value: "",
      error: void 0
    });
    fe(() => {
      C() && r?.focus({
        preventScroll: !0
      });
    });
    async function z(u) {
      u.preventDefault();
      const p = u.currentTarget, f = new FormData(p).get("apiKey");
      if (!f?.trim()) {
        x("error", n.t("provider.connect.apiKey.required"));
        return;
      }
      x("error", void 0), await d().api.integration.connect.key({
        integrationID: a.provider,
        location: F(),
        key: f
      }), await G();
    }
    return C() ? (() => {
      var u = Mt(), p = u.firstChild, m = p.firstChild;
      return t(u, e(j, {
        get when() {
          return I().id === "opencode";
        },
        get fallback() {
          return n.t("provider.connect.apiKey.description", {
            provider: I().name
          });
        },
        get children() {
          var f = Rt(), _ = f.firstChild, D = _.nextSibling, b = D.nextSibling;
          return t(_, () => n.t("provider.connect.opencodeZen.line1")), t(D, () => n.t("provider.connect.opencodeZen.line2")), t(b, () => n.t("provider.connect.opencodeZen.visit.prefix"), null), t(b, e(le, {
            href: "https://opencode.ai/zen",
            class: "text-v2-text-text-base focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-v2-border-border-focus",
            get children() {
              return n.t("provider.connect.opencodeZen.visit.link");
            }
          }), null), t(b, () => n.t("provider.connect.opencodeZen.visit.suffix"), null), f;
        }
      }), p), p.addEventListener("submit", z), t(m, () => n.t("provider.connect.apiKey.label", {
        provider: I().name
      }), null), t(m, e(Se, {
        ref(f) {
          var _ = r;
          typeof _ == "function" ? _(f) : r = f;
        },
        class: "!w-full",
        name: "apiKey",
        "data-input": "provider-api-key",
        get placeholder() {
          return n.t("provider.connect.apiKey.placeholder");
        },
        get value() {
          return s.value;
        },
        get invalid() {
          return s.error !== void 0;
        },
        get "aria-describedby"() {
          return s.error ? o : void 0;
        },
        autocomplete: "off",
        spellcheck: !1,
        onInput: (f) => x("value", f.currentTarget.value)
      }), null), t(p, e(j, {
        get when() {
          return s.error;
        },
        children: (f) => (() => {
          var _ = Te();
          return re(_, "id", o), t(_, f), _;
        })()
      }), null), t(p, e(ze, {
        type: "submit",
        variant: "contrast",
        "data-action": "provider-connect-submit",
        get children() {
          return n.t("common.continue");
        }
      }), null), u;
    })() : (() => {
      var u = qt(), p = u.firstChild;
      return t(u, e(ie, {
        get children() {
          return [e(O, {
            get when() {
              return I().id === "opencode";
            },
            get children() {
              var m = Bt(), f = m.firstChild, _ = f.nextSibling, D = _.nextSibling;
              return t(f, () => n.t("provider.connect.opencodeZen.line1")), t(_, () => n.t("provider.connect.opencodeZen.line2")), t(D, () => n.t("provider.connect.opencodeZen.visit.prefix"), null), t(D, e(le, {
                href: "https://opencode.ai/zen",
                tabIndex: -1,
                get children() {
                  return n.t("provider.connect.opencodeZen.visit.link");
                }
              }), null), t(D, () => n.t("provider.connect.opencodeZen.visit.suffix"), null), m;
            }
          }), e(O, {
            when: !0,
            get children() {
              var m = Fe();
              return t(m, () => n.t("provider.connect.apiKey.description", {
                provider: I().name
              })), m;
            }
          })];
        }
      }), p), p.addEventListener("submit", z), t(p, e(Q, {
        get autofocus() {
          return !C();
        },
        ref(m) {
          var f = r;
          typeof f == "function" ? f(m) : r = m;
        },
        type: "text",
        get label() {
          return n.t("provider.connect.apiKey.label", {
            provider: I().name
          });
        },
        get placeholder() {
          return n.t("provider.connect.apiKey.placeholder");
        },
        name: "apiKey",
        get value() {
          return s.value;
        },
        onChange: (m) => x("value", m),
        get validationState() {
          return s.error ? "invalid" : void 0;
        },
        get error() {
          return s.error;
        }
      }), null), t(p, e(ae, {
        class: "w-auto",
        type: "submit",
        size: "large",
        variant: "primary",
        get children() {
          return n.t("common.continue");
        }
      }), null), u;
    })();
  }
  function Qe() {
    let r;
    const o = Ee(), [s, x] = ne({
      value: "",
      error: void 0
    });
    fe(() => {
      C() && r?.focus({
        preventScroll: !0
      });
    });
    async function z(u) {
      u.preventDefault();
      const p = u.currentTarget, f = new FormData(p).get("code");
      if (!f?.trim()) {
        x("error", n.t("provider.connect.oauth.code.required"));
        return;
      }
      x("error", void 0);
      const _ = await d().api.integration.oauth.complete({
        integrationID: a.provider,
        attemptID: l.authorization.attemptID,
        location: F(),
        code: f
      }).then(() => ({
        ok: !0
      })).catch((D) => ({
        ok: !1,
        error: D
      }));
      if (_.ok) {
        await G();
        return;
      }
      x("error", q(_.error, n.t("provider.connect.oauth.code.invalid")));
    }
    return C() ? (() => {
      var u = Ft(), p = u.firstChild, m = p.nextSibling, f = m.firstChild;
      return t(p, () => n.t("provider.connect.oauth.code.visit.prefix"), null), t(p, e(le, {
        get href() {
          return l.authorization.url;
        },
        class: "text-v2-text-text-base",
        get children() {
          return n.t("provider.connect.oauth.code.visit.link");
        }
      }), null), t(p, () => n.t("provider.connect.oauth.code.visit.suffix", {
        provider: I().name
      }), null), m.addEventListener("submit", z), t(f, () => n.t("provider.connect.oauth.code.label", {
        method: L()?.label ?? ""
      }), null), t(f, e(Se, {
        ref(_) {
          var D = r;
          typeof D == "function" ? D(_) : r = _;
        },
        class: "!w-full",
        name: "code",
        get placeholder() {
          return n.t("provider.connect.oauth.code.placeholder");
        },
        get value() {
          return s.value;
        },
        get invalid() {
          return s.error !== void 0;
        },
        get "aria-describedby"() {
          return s.error ? o : void 0;
        },
        autocomplete: "off",
        spellcheck: !1,
        onInput: (_) => x("value", _.currentTarget.value)
      }), null), t(m, e(j, {
        get when() {
          return s.error;
        },
        children: (_) => (() => {
          var D = Te();
          return re(D, "id", o), t(D, _), D;
        })()
      }), null), t(m, e(ze, {
        type: "submit",
        variant: "contrast",
        get children() {
          return n.t("common.continue");
        }
      }), null), u;
    })() : (() => {
      var u = Tt(), p = u.firstChild, m = p.nextSibling;
      return t(p, () => n.t("provider.connect.oauth.code.visit.prefix"), null), t(p, e(le, {
        get href() {
          return l.authorization.url;
        },
        get children() {
          return n.t("provider.connect.oauth.code.visit.link");
        }
      }), null), t(p, () => n.t("provider.connect.oauth.code.visit.suffix", {
        provider: I().name
      }), null), m.addEventListener("submit", z), t(m, e(Q, {
        get autofocus() {
          return !C();
        },
        ref(f) {
          var _ = r;
          typeof _ == "function" ? _(f) : r = f;
        },
        type: "text",
        get label() {
          return n.t("provider.connect.oauth.code.label", {
            method: L()?.label ?? ""
          });
        },
        get placeholder() {
          return n.t("provider.connect.oauth.code.placeholder");
        },
        name: "code",
        get value() {
          return s.value;
        },
        onChange: (f) => x("value", f),
        get validationState() {
          return s.error ? "invalid" : void 0;
        },
        get error() {
          return s.error;
        }
      }), null), t(m, e(ae, {
        class: "w-auto",
        type: "submit",
        size: "large",
        variant: "primary",
        get children() {
          return n.t("common.continue");
        }
      }), null), u;
    })();
  }
  function Je() {
    const r = A(() => {
      const o = l.authorization?.instructions;
      return o?.includes(":") ? o.split(":").pop()?.trim() : o;
    });
    return fe(() => {
      const o = async () => {
        const s = l.authorization;
        if (!s || !P.value) return;
        const x = await d().api.integration.oauth.status({
          integrationID: a.provider,
          attemptID: s.attemptID,
          location: F()
        }).then((z) => ({
          ok: !0,
          status: z.data
        })).catch((z) => ({
          ok: !1,
          error: z
        }));
        if (P.value) {
          if (!x.ok) {
            B({
              type: "auth.error",
              error: q(x.error, n.t("common.requestFailed"))
            });
            return;
          }
          if (x.status.status === "complete") {
            await G();
            return;
          }
          if (x.status.status === "failed") {
            B({
              type: "auth.error",
              error: x.status.message
            });
            return;
          }
          if (x.status.status === "expired") {
            B({
              type: "auth.error",
              error: n.t("common.requestFailed")
            });
            return;
          }
          $.current = setTimeout(o, 1e3);
        }
      };
      o();
    }), (() => {
      var o = Ot(), s = o.firstChild, x = s.nextSibling, z = x.firstChild;
      return t(s, () => n.t("provider.connect.oauth.auto.visit.prefix"), null), t(s, e(le, {
        get href() {
          return l.authorization.url;
        },
        get children() {
          return n.t("provider.connect.oauth.auto.visit.link");
        }
      }), null), t(s, () => n.t("provider.connect.oauth.auto.visit.suffix", {
        provider: I().name
      }), null), t(o, e(Q, {
        get label() {
          return n.t("provider.connect.oauth.auto.confirmationCode");
        },
        class: "font-mono",
        get value() {
          return r();
        },
        readOnly: !0,
        copyable: !0
      }), x), t(x, e(me, {}), z), t(z, () => n.t("provider.connect.status.waiting")), o;
    })();
  }
  return (() => {
    var r = Ut(), o = r.firstChild, s = o.firstChild, x = o.nextSibling, z = x.firstChild;
    return t(o, e(be, {
      get id() {
        return a.provider;
      },
      get class() {
        return C() ? "mt-0.5 size-4 shrink-0 text-v2-icon-icon-base" : "size-5 shrink-0 icon-strong-base";
      }
    }), s), t(s, e(ie, {
      get children() {
        return [e(O, {
          get when() {
            return xe(() => a.provider === "anthropic")() && L()?.label?.toLowerCase().includes("max");
          },
          get children() {
            return n.t("provider.connect.title.anthropicProMax");
          }
        }), e(O, {
          when: !0,
          get children() {
            return n.t("provider.connect.title", {
              provider: I().name
            });
          }
        })];
      }
    })), z.$$keydown = H, t(z, e(ie, {
      get children() {
        return [e(O, {
          get when() {
            return w();
          },
          get children() {
            var u = $e(), p = u.firstChild, m = p.firstChild;
            return t(p, e(me, {}), m), t(m, () => n.t("provider.connect.status.inProgress")), u;
          }
        }), e(O, {
          get when() {
            return l.methodIndex === void 0;
          },
          get children() {
            return e(X, {});
          }
        }), e(O, {
          get when() {
            return l.state === "pending";
          },
          get children() {
            var u = $e(), p = u.firstChild, m = p.firstChild;
            return t(p, e(me, {}), m), t(m, () => n.t("provider.connect.status.inProgress")), u;
          }
        }), e(O, {
          get when() {
            return l.state === "prompt";
          },
          get children() {
            return e(ee, {});
          }
        }), e(O, {
          get when() {
            return l.state === "error";
          },
          get children() {
            var u = $e(), p = u.firstChild, m = p.firstChild;
            return t(p, e(De, {
              name: "circle-ban-sign",
              class: "text-icon-critical-base"
            }), m), t(m, () => n.t("provider.connect.status.failed", {
              error: l.error ?? ""
            })), u;
          }
        }), e(O, {
          get when() {
            return L()?.type === "key";
          },
          get children() {
            return e(Ne, {});
          }
        }), e(O, {
          get when() {
            return L()?.type === "oauth";
          },
          get children() {
            return e(ie, {
              get children() {
                return [e(O, {
                  get when() {
                    return l.authorization?.mode === "code";
                  },
                  get children() {
                    return e(Qe, {});
                  }
                }), e(O, {
                  get when() {
                    return l.authorization?.mode === "auto";
                  },
                  get children() {
                    return e(Je, {});
                  }
                })];
              }
            });
          }
        })];
      }
    })), ve((u) => {
      var p = C() ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6 px-2.5 pb-3", m = C() ? "flex h-10 shrink-0 items-start gap-2 px-3" : "flex items-center gap-4 px-2.5", f = C() ? "text-[15px] font-[530] leading-5 tracking-[-0.13px] text-v2-text-text-base" : "text-16-medium text-text-strong", _ = C() ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6 px-2.5 pb-10", D = C() ? void 0 : 0, b = !C() && l.methodIndex === void 0 ? !0 : void 0;
      return p !== u.e && ge(r, u.e = p), m !== u.t && ge(o, u.t = m), f !== u.a && ge(s, u.a = f), _ !== u.o && ge(x, u.o = _), D !== u.i && re(z, "tabindex", u.i = D), b !== u.n && (z.autofocus = u.n = b), u;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0,
      i: void 0,
      n: void 0
    }), r;
  })();
}
ut(["click", "keydown"]);
const Nt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DialogConnectProvider: jt,
  useProviderConnectController: Ge
}, Symbol.toStringTag, { value: "Module" }));
export {
  jt as D,
  le as E,
  Gt as a,
  Nt as d,
  Ge as u
};
