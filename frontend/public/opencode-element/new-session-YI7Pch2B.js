import { b$ as A, aL as X, b3 as ge, aT as H, bo as M, b6 as m, at as r, I as $, aK as F, bl as U, aw as N, l as y, bQ as Y, a2 as w, aH as I, bF as _, o as R, ba as W, bL as p, bI as he, bJ as fe, bc as pe, H as ee, b2 as te, b1 as re, t as P, aD as ye, aR as ne, cb as E, cm as oe, c2 as be, c8 as le, ca as ae, aC as V, aP as xe, bK as G, al as q, bA as we, a_ as ke, ch as Z, bS as Se, c1 as $e, ci as Ce, cc as je, bT as _e, aF as Pe, aG as Ve, c9 as De, bP as Ie, aN as B, ao as se, x as S, b0 as J, ad as ce, G as He, ac as Ae, a4 as Me, ap as Re, J as Te, bV as ie, bp as Ke, z as ze, b5 as Le, bR as Oe, cl as Fe, ck as Ne, cp as We, aI as Ee } from "./skynet-element-dDv65e_D.js";
var Ze = /* @__PURE__ */ p('<button type=button class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover">'), Ue = /* @__PURE__ */ p('<div class="flex flex-col p-0.5"><div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted"><input aria-autocomplete=list aria-controls=prompt-project-menu class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"></div><div class="max-h-[224px] overflow-y-auto">'), Ge = /* @__PURE__ */ p('<div class="h-px bg-v2-border-border-muted">'), qe = /* @__PURE__ */ p('<span data-slot=dropdown-menu-item-label class="min-w-0 flex-1 truncate leading-5">'), Be = /* @__PURE__ */ p('<div class="flex flex-col p-0.5">'), Je = /* @__PURE__ */ p('<div><div class="flex h-7 select-none items-center pl-1.5 pr-3 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-text-text-faint">'), Qe = /* @__PURE__ */ p('<button data-action=prompt-project type=button class="flex h-7 min-w-0 max-w-[160px] items-center gap-1.5 rounded-sm px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"><span class="min-w-0 truncate leading-5">'), Xe = /* @__PURE__ */ p('<button><span class="min-w-0 truncate leading-5">');
const z = "action:", ue = "project:";
function D(e) {
  return `${ue}${encodeURIComponent(e.server?.key ?? "")}:${encodeURIComponent(e.worktree)}`;
}
function K(e) {
  return `${z}${encodeURIComponent(e ?? "")}`;
}
function Ye(e) {
  const o = A(), [c, l] = X({
    open: !1,
    search: "",
    active: ""
  });
  let a;
  const d = () => {
    const t = M(e.controls().directory);
    return e.controls().available.find((i) => (!i.server || i.server.key === e.controls().server) && (M(i.worktree) === t || i.sandboxes?.some((f) => M(f) === t)));
  }, v = () => d() ?? e.controls().available[0], g = () => {
    const t = c.search.trim().toLowerCase();
    return t ? e.controls().available.filter((i) => H(i).toLowerCase().includes(t)) : e.controls().available;
  }, u = () => e.controls().available.map((t) => t.server).filter((t, i, f) => t && f.findIndex((s) => s?.key === t.key) === i), h = () => u().length <= 1 ? [...g().map(D), K(u()[0]?.key)] : [...u().flatMap((t) => g().filter((i) => i.server?.key === t.key).map(D)), K()], b = () => {
    const t = v() ? D(v()) : void 0, i = h();
    return t && i.includes(t) ? t : i[0] ?? "";
  }, x = () => {
    l({
      open: !1,
      search: "",
      active: ""
    }), e.onDone();
  }, C = (t) => {
    (M(t.worktree) !== M(d()?.worktree ?? "") || t.server?.key !== d()?.server?.key) && e.controls().select(t.worktree, t.server?.key), x();
  }, k = (t) => {
    l({
      open: !1,
      search: "",
      active: ""
    }), e.controls().add(o.t("command.project.open"), t);
  }, n = (t) => {
    const i = t.trim().toLowerCase(), f = e.controls().available.find((s) => !i || H(s).toLowerCase().includes(i));
    l({
      search: t,
      active: f ? D(f) : K(u().length > 1 ? void 0 : u()[0]?.key)
    });
  };
  return {
    selected: v,
    empty: () => e.controls().available.length === 0,
    projects: g,
    servers: u,
    projectKey: D,
    actionKey: K,
    open: () => c.open,
    search: () => c.search,
    active: () => c.active,
    labels: {
      add: () => o.t("session.new.project.add"),
      clear: () => o.t("common.clear"),
      new: () => o.t("session.new.project.new"),
      search: () => o.t("session.new.project.search")
    },
    add: k,
    select: C,
    setOpen(t) {
      if (t) {
        l({
          open: !0,
          active: b()
        }), setTimeout(() => requestAnimationFrame(() => a?.focus()));
        return;
      }
      l({
        open: !1,
        search: "",
        active: ""
      });
    },
    setSearch: n,
    clearSearch() {
      l({
        search: "",
        active: b()
      }), setTimeout(() => a?.focus());
    },
    setActive(t) {
      l("active", t);
    },
    moveActive(t) {
      const i = h();
      if (i.length === 0) return;
      const f = i.indexOf(c.active);
      l("active", i[((f === -1 ? 0 : f) + t + i.length) % i.length]);
    },
    activeProject() {
      return c.active.startsWith(ue) ? g().find((t) => D(t) === c.active) : void 0;
    },
    activeServer() {
      return c.active.startsWith(z) && decodeURIComponent(c.active.slice(z.length)) || void 0;
    },
    activeAction() {
      return c.active.startsWith(z);
    },
    setSearchRef(t) {
      a = t;
    },
    focusSearch() {
      setTimeout(() => requestAnimationFrame(() => a?.focus()));
    },
    handleSearchKeydown(t) {
      return ge(a, t, c.search, n);
    }
  };
}
function et(e) {
  const [o, c] = F(!1);
  let l;
  const a = ye(() => l);
  let d;
  const v = (n) => {
    const t = () => {
      if (!n.isConnected) {
        d = requestAnimationFrame(t);
        return;
      }
      d = void 0, c(!0);
    };
    t();
  };
  U(() => {
    d !== void 0 && cancelAnimationFrame(d);
  });
  const g = () => e.controller.active() ? l?.querySelector(`[data-option-key="${CSS.escape(e.controller.active())}"]`) : void 0, u = (n) => {
    a.preventTriggerRestore(), e.controller.setOpen(!1), a.afterClose(() => e.controller.select(n));
  }, h = (n) => {
    a.preventTriggerRestore(), e.controller.setOpen(!1), a.afterClose(() => e.controller.add(n));
  }, b = () => {
    const n = e.controller.activeProject();
    if (n) {
      u(n);
      return;
    }
    if (e.controller.activeAction() && e.controller.servers().length > 1) {
      const t = g();
      t?.focus(), t?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: !0
      }));
      return;
    }
    h(e.controller.activeServer());
  }, x = (n) => {
    e.controller.moveActive(n), queueMicrotask(() => g()?.scrollIntoView({
      block: "nearest"
    }));
  }, C = () => {
    const n = Array.from(document.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((t) => !l?.contains(t) && !t.hasAttribute("data-focus-trap")).findLast((t) => t.offsetParent !== null);
    a.preventTriggerRestore(), n?.focus(), queueMicrotask(() => {
      e.controller.open() && e.controller.setOpen(!1);
    });
  }, k = () => {
    const n = e.controller.selected();
    return n ? e.controller.projectKey(n) : void 0;
  };
  return N(() => {
    if (!e.controller.open()) return;
    const n = (t) => e.controller.handleSearchKeydown(t);
    document.addEventListener("keydown", n, !0), U(() => document.removeEventListener("keydown", n, !0));
  }), r(y, {
    get open() {
      return W(() => !!o())() && e.controller.open();
    },
    get placement() {
      return e.placement ?? "bottom";
    },
    gutter: 4,
    modal: !1,
    onOpenChange: (n) => {
      n && a.allowTriggerRestore(), e.controller.setOpen(n);
    },
    get children() {
      return [r(y.Trigger, {
        as: rt,
        ref: v,
        get controller() {
          return e.controller;
        }
      }), r(y.Portal, {
        get children() {
          return r(y.Content, {
            ref(n) {
              var t = l;
              typeof t == "function" ? t(n) : l = n;
            },
            id: "prompt-project-menu",
            class: "w-[243px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none [&[data-closed]]:!animate-none",
            onOpenAutoFocus: (n) => n.preventDefault(),
            get onPointerDownOutside() {
              return a.preventTriggerRestore;
            },
            get onFocusOutside() {
              return a.preventTriggerRestore;
            },
            get onCloseAutoFocus() {
              return a.onCloseAutoFocus;
            },
            get children() {
              return [(() => {
                var n = Ue(), t = n.firstChild, i = t.firstChild, f = t.nextSibling;
                return m(t, r($, {
                  name: "magnifying-glass",
                  size: "small",
                  class: "shrink-0"
                }), i), i.$$keydown = (s) => {
                  if (s.key === "Tab") {
                    if (s.preventDefault(), s.stopPropagation(), s.shiftKey) {
                      C();
                      return;
                    }
                    g()?.focus();
                    return;
                  }
                  if (s.stopPropagation(), s.key === "Escape") {
                    s.preventDefault(), e.controller.setOpen(!1);
                    return;
                  }
                  if (!(s.altKey || s.metaKey)) {
                    if (s.key === "ArrowDown") {
                      s.preventDefault(), x(1);
                      return;
                    }
                    if (s.key === "ArrowUp") {
                      s.preventDefault(), x(-1);
                      return;
                    }
                    s.key === "Enter" && !s.isComposing && (s.preventDefault(), b());
                  }
                }, i.$$input = (s) => e.controller.setSearch(s.currentTarget.value), Y((s) => e.controller.setSearchRef(s), i), m(t, r(w, {
                  get when() {
                    return e.controller.search().trim();
                  },
                  get children() {
                    var s = Ze();
                    return s.$$click = () => e.controller.clearSearch(), s.$$pointerdown = (j) => j.preventDefault(), m(s, r($, {
                      name: "close-small",
                      size: "small"
                    })), I(() => _(s, "aria-label", e.controller.labels.clear())), s;
                  }
                }), null), m(f, r(w, {
                  get when() {
                    return e.controller.servers().length > 1;
                  },
                  get fallback() {
                    return r(y.RadioGroup, {
                      get value() {
                        return k();
                      },
                      get children() {
                        return r(R, {
                          get each() {
                            return e.controller.projects();
                          },
                          children: (s) => r(Q, {
                            project: s,
                            get controller() {
                              return e.controller;
                            },
                            onSelect: u
                          })
                        });
                      }
                    });
                  },
                  get children() {
                    return r(R, {
                      get each() {
                        return e.controller.servers().filter((s) => e.controller.projects().some((j) => j.server?.key === s.key));
                      },
                      children: (s) => (() => {
                        var j = Je(), T = j.firstChild;
                        return m(T, () => s.name), m(j, r(y.RadioGroup, {
                          get value() {
                            return k();
                          },
                          get children() {
                            return r(R, {
                              get each() {
                                return e.controller.projects().filter((L) => L.server?.key === s.key);
                              },
                              children: (L) => r(Q, {
                                project: L,
                                get controller() {
                                  return e.controller;
                                },
                                onSelect: u
                              })
                            });
                          }
                        }), null), j;
                      })()
                    });
                  }
                })), I((s) => {
                  var j = e.controller.labels.search(), T = e.controller.active() || void 0;
                  return j !== s.e && _(i, "placeholder", s.e = j), T !== s.t && _(i, "aria-activedescendant", s.t = T), s;
                }, {
                  e: void 0,
                  t: void 0
                }), I(() => i.value = e.controller.search()), n;
              })(), Ge(), (() => {
                var n = Be();
                return m(n, r(w, {
                  get when() {
                    return e.controller.servers().length > 1;
                  },
                  get fallback() {
                    return r(nt, {
                      get server() {
                        return e.controller.servers()[0]?.key;
                      },
                      get controller() {
                        return e.controller;
                      },
                      onSelect: h
                    });
                  },
                  get children() {
                    return r(y.Sub, {
                      get children() {
                        return [r(y.SubTrigger, {
                          get id() {
                            return e.controller.actionKey();
                          },
                          get "data-option-key"() {
                            return e.controller.actionKey();
                          },
                          class: de,
                          get classList() {
                            return {
                              "!bg-v2-overlay-simple-overlay-hover": e.controller.active() === e.controller.actionKey()
                            };
                          },
                          onMouseEnter: () => e.controller.setActive(e.controller.actionKey()),
                          get children() {
                            return [r($, {
                              name: "plus",
                              size: "small"
                            }), (() => {
                              var t = qe();
                              return m(t, () => e.controller.labels.add()), t;
                            })(), r($, {
                              name: "chevron-right",
                              size: "small",
                              class: "shrink-0 text-v2-icon-icon-muted"
                            })];
                          }
                        }), r(y.Portal, {
                          get children() {
                            return r(y.SubContent, {
                              class: "min-w-[180px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 p-0.5 shadow-[var(--v2-elevation-floating)] focus:outline-none",
                              get children() {
                                return r(R, {
                                  get each() {
                                    return e.controller.servers();
                                  },
                                  children: (t) => r(ot, {
                                    server: t,
                                    onSelect: h
                                  })
                                });
                              }
                            });
                          }
                        })];
                      }
                    });
                  }
                })), n;
              })()];
            }
          });
        }
      })];
    }
  });
}
function tt(e) {
  return (() => {
    var o = Qe(), c = o.firstChild;
    return o.$$click = () => e.controller.add(), m(o, r($, {
      name: "folder-add-left",
      size: "small",
      class: "shrink-0 text-v2-icon-icon-muted"
    }), c), m(c, () => e.controller.labels.new()), m(o, r($, {
      name: "chevron-down",
      size: "small",
      class: "shrink-0 text-v2-icon-icon-muted"
    }), null), o;
  })();
}
function rt(e) {
  const [o, c] = he(e, ["controller", "class", "classList", "onClick", "onKeyDown"]), l = () => o.controller.selected();
  return (() => {
    var a = Xe(), d = a.firstChild;
    return fe(a, pe(c, {
      "data-action": "prompt-project",
      type: "button",
      class: "flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 transition-colors focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none",
      get classList() {
        return {
          ...o.classList,
          "hover:bg-v2-overlay-simple-overlay-hover": !o.controller.open(),
          "bg-v2-overlay-simple-overlay-pressed": o.controller.open(),
          "text-v2-text-text-muted": o.controller.open()
        };
      },
      get onClick() {
        return o.onClick ?? (() => o.controller.setOpen(!0));
      },
      onKeyDown: (v) => {
        if (!o.controller.open() && (v.key === "ArrowDown" || v.key === "ArrowUp")) {
          v.preventDefault(), v.stopPropagation();
          return;
        }
        typeof o.onKeyDown == "function" && o.onKeyDown(v);
      }
    }), !1, !0), m(a, r(w, {
      get when() {
        return l();
      },
      get fallback() {
        return r($, {
          name: "folder-add-left",
          size: "small",
          class: "shrink-0 text-v2-icon-icon-muted"
        });
      },
      children: (v) => r(ee, {
        get fallback() {
          return H(v());
        },
        get src() {
          return re(v().id, v().icon);
        },
        get variant() {
          return te(v().icon?.color);
        }
      })
    }), d), m(d, (() => {
      var v = W(() => !!l());
      return () => v() ? H(l()) : o.controller.labels.new();
    })()), m(a, r($, {
      name: "chevron-down",
      size: "small",
      class: "shrink-0 text-v2-icon-icon-muted"
    }), null), a;
  })();
}
function Q(e) {
  const o = () => e.controller.projectKey(e.project);
  return r(y.RadioItem, {
    get id() {
      return o();
    },
    get value() {
      return o();
    },
    get "data-option-key"() {
      return o();
    },
    class: "h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base data-[highlighted]:!bg-v2-overlay-simple-overlay-hover",
    get classList() {
      return {
        "!bg-v2-overlay-simple-overlay-hover": e.controller.active() === o()
      };
    },
    style: {
      "font-family": "var(--v2-font-family-sans)",
      "font-size": "13px",
      "font-weight": 440,
      "line-height": "20px",
      "letter-spacing": "-0.04px",
      color: "var(--v2-text-text-base)",
      padding: "0 12px"
    },
    closeOnSelect: !0,
    onMouseEnter: () => {
      e.controller.setActive(o()), e.controller.focusSearch();
    },
    onSelect: () => e.onSelect(e.project),
    get children() {
      return [r(ee, {
        get fallback() {
          return H(e.project);
        },
        get src() {
          return re(e.project.id, e.project.icon);
        },
        get variant() {
          return te(e.project.icon?.color);
        }
      }), r(y.ItemLabel, {
        class: "min-w-0 truncate leading-5",
        get children() {
          return H(e.project);
        }
      }), r(y.ItemIndicator, {
        style: {
          width: "14px",
          height: "14px",
          right: "12px"
        },
        get children() {
          return r(P, {
            name: "check",
            size: "small",
            class: "shrink-0 text-v2-icon-icon-base"
          });
        }
      })];
    }
  });
}
const de = "h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] data-[highlighted]:!bg-v2-overlay-simple-overlay-hover";
function nt(e) {
  const o = () => e.controller.actionKey(e.server);
  return r(y.Item, {
    get id() {
      return o();
    },
    get "data-option-key"() {
      return o();
    },
    class: "h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base data-[highlighted]:!bg-v2-overlay-simple-overlay-hover",
    get classList() {
      return {
        "!bg-v2-overlay-simple-overlay-hover": e.controller.active() === o()
      };
    },
    style: {
      "font-family": "var(--v2-font-family-sans)",
      "font-size": "13px",
      "font-weight": 440,
      "line-height": "20px",
      "letter-spacing": "-0.04px",
      color: "var(--v2-text-text-base)",
      padding: "0 12px"
    },
    onMouseEnter: () => {
      e.controller.setActive(o()), e.controller.focusSearch();
    },
    onSelect: () => e.onSelect(e.server),
    get children() {
      return [r($, {
        name: "plus",
        size: "small"
      }), r(y.ItemLabel, {
        class: "min-w-0 truncate leading-5",
        get children() {
          return e.controller.labels.add();
        }
      })];
    }
  });
}
function ot(e) {
  return r(y.Item, {
    class: de,
    onSelect: () => e.onSelect(e.server.key),
    get children() {
      return r(y.ItemLabel, {
        class: "min-w-0 flex-1 truncate leading-5",
        get children() {
          return e.server.name;
        }
      });
    }
  });
}
ne(["input", "keydown", "pointerdown", "click"]);
function lt(e) {
  const o = E(), c = oe(), l = be(), a = le(), d = ae(() => o().directory), v = V(() => new Set(d.connected().map((n) => n.id))), g = (n) => !!d.all().get(n.providerID)?.models[n.modelID] && v().has(n.providerID), u = () => {
    const n = c().data.config.model;
    if (!n) return;
    const [t, i] = n.split("/"), f = { providerID: t, modelID: i };
    if (g(f)) return f;
  }, h = () => l.recent.list().find(g), b = () => {
    const n = d.default();
    return d.connected().flatMap((t) => {
      const i = n[t.id] ?? Object.values(t.models)[0]?.id;
      return i ? [{ providerID: t.id, modelID: i }] : [];
    })[0];
  }, x = () => {
    const n = [a.model.current(), e.agent()?.model, u(), h(), b()].find(
      (t) => !!t && g(t)
    );
    if (n)
      return l.find(n);
  }, C = V(
    () => l.recent.list().map(l.find).filter((n) => !!n)
  ), k = {
    ready: l.ready,
    current: x,
    recent: C,
    list: l.list,
    cycle(n) {
      const t = C(), i = x();
      if (!i) return;
      const f = t.findIndex((j) => j.provider.id === i.provider.id && j.id === i.id);
      if (f === -1) return;
      const s = t[(f + n + t.length) % t.length];
      s && k.set({ providerID: s.provider.id, modelID: s.id });
    },
    set(n, t) {
      G(
        () => q(() => {
          a.model.set(n ? { ...n, variant: a.model.current()?.variant } : void 0), n && (l.setVisibility(n, !0), t?.recent && l.recent.push(n));
        })
      );
    },
    visible: l.visible,
    setVisibility: l.setVisibility,
    variant: {
      configured() {
        const n = e.agent(), t = x();
        if (!(!n || !t))
          return ke({
            agent: { model: n.model, variant: n.variant },
            model: { providerID: t.provider.id, modelID: t.id, variants: t.variants }
          });
      },
      selected() {
        return a.model.current()?.variant;
      },
      current() {
        const n = we({
          variants: this.list(),
          selected: this.selected(),
          configured: this.configured()
        });
        if (n) return n;
        const t = x();
        if (!t) return;
        const i = l.variant.get({ providerID: t.provider.id, modelID: t.id });
        if (i && this.list().includes(i)) return i;
      },
      list() {
        return Object.keys(x()?.variants ?? {});
      },
      set(n) {
        G(
          () => q(() => {
            const t = x();
            t && (a.model.set({ providerID: t.provider.id, modelID: t.id, variant: n ?? null }), l.variant.set({ providerID: t.provider.id, modelID: t.id }, n));
          })
        );
      },
      cycle() {
        const n = this.list();
        n.length !== 0 && this.set(
          xe({
            variants: n,
            selected: this.selected(),
            configured: this.configured()
          })
        );
      }
    }
  };
  return k;
}
function at(e) {
  const o = le(), c = Z(), l = Se(), a = $e(), d = Ce(), [v, g] = je(), u = lt({ agent: () => a.agent.current() });
  _e({ model: u });
  const h = Pe({
    sessionKey: d.sessionKey,
    sessionID: () => d.params.id,
    queryOptions: c().queryOptions,
    model: u
  }), b = Ve(), x = De({
    get controls() {
      return h();
    },
    get newSessionWorktree() {
      return e.worktree();
    },
    onNewSessionWorktreeReset: e.resetWorktree,
    onSubmit: l.clear
  });
  return N(() => {
    o.ready() && Ie(() => {
      const C = v.prompt;
      C && (o.set([{ type: "text", content: C, start: 0, end: C.length }], C.length), g({ ...v, prompt: void 0 }));
    });
  }), {
    input: x,
    prompt: {
      ready: o.ready,
      readyPromise: () => o.ready.promise
    },
    project: {
      controls: b
    }
  };
}
var st = /* @__PURE__ */ p('<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 720 129"fill=none><g opacity=0.6><g><g opacity=0.16><path opacity=0.7 d="M55.3846 36.4286H18.4615V91.7143H55.3846V36.4286ZM73.8462 110.143H0V18H73.8462V110.143Z"fill=currentColor></path><path opacity=0.7 d="M110.462 91.7143H147.385V36.4286H110.462V91.7143ZM165.846 110.143H110.462V128.571H92V18H165.846V110.143Z"fill=currentColor></path><path opacity=0.7 d="M258.846 73.2857H203.462V91.7143H258.846V110.143H185V18H258.846V73.2857ZM203.462 54.8571H240.385V36.4286H203.462V54.8571Z"fill=currentColor></path><path opacity=0.7 d="M332.385 36.4286H295.462V110.143H277V18H332.385V36.4286ZM350.846 110.143H332.385V36.4286H350.846V110.143Z"fill=currentColor></path><path opacity=0.7 d="M442.846 36.4286H387.462V91.7143H442.846V110.143H369V18H442.846V36.4286Z"fill=currentColor></path><path opacity=0.7 d="M517.385 36.4286H480.462V91.7143H517.385V36.4286ZM535.846 110.143H462V18H535.846V110.143Z"fill=currentColor></path><path opacity=0.7 d="M609.385 36.8571H572.462V92.1429H609.385V36.8571ZM627.846 110.571H554V18.4286H609.385V0H627.846V110.571Z"fill=currentColor></path><path opacity=0.7 d="M664.462 36.4286V54.8571H701.385V36.4286H664.462ZM719.846 73.2857H664.462V91.7143H719.846V110.143H646V18H719.846V73.2857Z"fill=currentColor></path></g></g></g><defs><mask maskUnits=userSpaceOnUse x=0 y=0 width=720 height=129 style=mask-type:alpha><rect width=720 height=129></rect></mask><linearGradient x1=360 y1=68 x2=360 y2=129 gradientUnits=userSpaceOnUse><stop stop-color=white stop-opacity=0.7></stop><stop offset=1 stop-color=white stop-opacity=0>');
function ct(e) {
  const o = B(), c = B();
  return (() => {
    var l = st(), a = l.firstChild, d = a.firstChild, v = a.nextSibling, g = v.firstChild, u = g.firstChild, h = g.nextSibling;
    return _(d, "mask", `url(#${o})`), _(g, "id", o), _(u, "fill", `url(#${c})`), _(h, "id", c), I((b) => se(l, {
      [e.class ?? ""]: !!e.class
    }, b)), l;
  })();
}
var ve = /* @__PURE__ */ p('<span class="hidden select-none opacity-50 sm:inline mx-1">/'), it = /* @__PURE__ */ p('<span class="min-w-0 truncate">'), O = /* @__PURE__ */ p('<span class="min-w-0 flex-1 truncate">'), ut = /* @__PURE__ */ p('<div class="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px]"><span class="min-w-0 truncate">');
function dt(e) {
  const o = A();
  let c;
  const l = () => e.value === e.projectRoot ? "main" : e.value, a = () => l() === "main" ? "monitor" : l() === "create" ? "workspace-new" : "workspace", d = (u) => {
    c = u;
  }, v = (u) => {
    if (u) return;
    const h = c;
    c = void 0, h && e.onChange(h), e.onDone();
  }, g = () => l() === "main" ? o.t("session.new.workspace.triggerLocal") : e.value === "create" ? o.t("workspace.new") : J(e.value);
  return [ve(), r(S, {
    placement: "bottom",
    gutter: 4,
    onOpenChange: v,
    get children() {
      return [r(S.Trigger, {
        class: "flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted",
        get children() {
          return [r(P, {
            get name() {
              return a();
            },
            class: "shrink-0 text-v2-icon-icon-muted"
          }), (() => {
            var u = it();
            return m(u, g), u;
          })(), r($, {
            name: "chevron-down",
            size: "small",
            class: "shrink-0 text-v2-icon-icon-muted"
          })];
        }
      }), r(S.Portal, {
        get children() {
          return r(S.Content, {
            class: "w-[180px]",
            get children() {
              return [r(S.Group, {
                get children() {
                  return [r(S.GroupLabel, {
                    get children() {
                      return o.t("session.new.workspace.runIn");
                    }
                  }), r(S.Item, {
                    onSelect: () => d("main"),
                    get children() {
                      return [r(P, {
                        name: "monitor"
                      }), (() => {
                        var u = O();
                        return m(u, () => o.t("session.new.workspace.local")), u;
                      })(), r(w, {
                        get when() {
                          return l() === "main";
                        },
                        get children() {
                          return r($, {
                            name: "check",
                            size: "small",
                            class: "shrink-0"
                          });
                        }
                      })];
                    }
                  }), r(S.Item, {
                    onSelect: () => d("create"),
                    get children() {
                      return [r(P, {
                        name: "workspace-new"
                      }), (() => {
                        var u = O();
                        return m(u, () => o.t("workspace.new")), u;
                      })(), r(w, {
                        get when() {
                          return l() === "create";
                        },
                        get children() {
                          return r($, {
                            name: "check",
                            size: "small",
                            class: "shrink-0"
                          });
                        }
                      })];
                    }
                  })];
                }
              }), r(w, {
                get when() {
                  return e.workspaces.length > 0;
                },
                get children() {
                  return [r(S.Separator, {}), r(S.Sub, {
                    gutter: 0,
                    overlap: !0,
                    overflowPadding: 8,
                    get children() {
                      return [r(S.SubTrigger, {
                        get children() {
                          return [r(P, {
                            name: "workspace"
                          }), W(() => o.t("session.new.workspace.existing"))];
                        }
                      }), r(S.Portal, {
                        get children() {
                          return r(S.SubContent, {
                            class: "max-w-[200px]",
                            get children() {
                              return r(R, {
                                get each() {
                                  return e.workspaces;
                                },
                                children: (u) => r(S.Item, {
                                  onSelect: () => d(u),
                                  get children() {
                                    return [r(P, {
                                      name: "workspace-isolated"
                                    }), (() => {
                                      var h = O();
                                      return m(h, () => J(u)), h;
                                    })(), r(w, {
                                      get when() {
                                        return l() === u;
                                      },
                                      get children() {
                                        return r($, {
                                          name: "check",
                                          size: "small",
                                          class: "shrink-0"
                                        });
                                      }
                                    })];
                                  }
                                })
                              });
                            }
                          });
                        }
                      })];
                    }
                  })];
                }
              })];
            }
          });
        }
      })];
    }
  }), r(me, {
    get branch() {
      return e.branch;
    }
  })];
}
function me(e) {
  const o = A(), c = () => e.noGit ? o.t("session.new.git.none") : e.branch;
  return r(w, {
    get when() {
      return c();
    },
    children: (l) => [ve(), r(ce, {
      placement: "top",
      get value() {
        return l();
      },
      class: "min-w-0 max-w-[220px]",
      contentClass: "max-w-[calc(100vw-32px)] break-all",
      get children() {
        var a = ut(), d = a.firstChild;
        return m(a, r($, {
          name: "branch",
          size: "small",
          class: "shrink-0 text-v2-icon-icon-muted"
        }), d), m(d, l), a;
      }
    })]
  });
}
const vt = "w-full max-w-[720px] px-0";
var mt = /* @__PURE__ */ p('<div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">'), gt = /* @__PURE__ */ p('<div class="@container relative flex flex-col min-h-0 h-full flex-1"><div data-component=session-new-design class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep"><div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6"><div><div class="mt-8 flex flex-col gap-8">'), ht = /* @__PURE__ */ p('<button type=button class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none">'), ft = /* @__PURE__ */ p('<div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10"><div data-component=provider-tip class="group/provider-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"><button type=button class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"><span class=truncate></span><span class="flex size-6 shrink-0 items-center justify-center"aria-hidden=true>');
const pt = 720 * 60 * 60 * 1e3;
function yt(e) {
  return (() => {
    var o = gt(), c = o.firstChild, l = c.firstChild, a = l.firstChild, d = a.firstChild;
    return Re(a, vt), m(a, r(ct, {
      class: "h-auto w-full text-v2-background-bg-inverse"
    }), d), m(d, r(Te, {
      get controller() {
        return e.input;
      }
    }), null), m(d, r(w, {
      get when() {
        return e.project.empty();
      },
      get children() {
        return r(tt, {
          get controller() {
            return e.project;
          }
        });
      }
    }), null), m(d, r(w, {
      get when() {
        return e.project.selected();
      },
      get children() {
        var v = mt();
        return m(v, r(et, {
          get controller() {
            return e.project;
          },
          placement: "bottom"
        }), null), m(v, r(w, {
          get when() {
            return e.workspace.bar.visible();
          },
          get fallback() {
            return r(me, {
              get branch() {
                return e.workspace.bar.branch();
              },
              get noGit() {
                return !e.workspace.project.git();
              }
            });
          },
          get children() {
            return r(dt, {
              get value() {
                return e.workspace.selection.value();
              },
              get projectRoot() {
                return e.workspace.project.root();
              },
              get workspaces() {
                return e.workspace.project.workspaces();
              },
              get branch() {
                return e.workspace.bar.branch();
              },
              get onChange() {
                return e.workspace.selection.set;
              },
              get onDone() {
                return e.input.restoreFocus;
              }
            });
          }
        }), null), v;
      }
    }), null), m(c, r(xt, {}), null), o;
  })();
}
function bt(e) {
  const o = A();
  return r(w, {
    get when() {
      return e.mount();
    },
    keyed: !0,
    children: (c) => r(He, {
      mount: c,
      get children() {
        return r(w, {
          get when() {
            return e.visible();
          },
          get children() {
            return r(Ae, {
              placement: "bottom",
              get value() {
                return o.t("status.popover.trigger");
              },
              get children() {
                return r(Me, {});
              }
            });
          }
        });
      }
    })
  });
}
function xt() {
  const e = A(), o = ie(), c = E(), l = Z(), a = ae(() => c().directory), [d, v, , g] = Ke(ze.global("new-session.provider-tip"), X({
    dismissedAt: 0
  })), u = V(() => l().child(c().directory)[0].provider_ready && g() && a.paid().length === 0 && Date.now() - d.dismissedAt >= pt), [h, b] = F(), x = Le({
    show: u,
    element: () => h() ?? null
  }), C = () => {
    import("./dialog-connect-provider-IYJDJgf0.js").then((k) => k.d).then(({
      DialogConnectProvider: k
    }) => {
      o.show(() => r(k, {
        directory: () => c().directory
      }));
    });
  };
  return r(w, {
    get when() {
      return x.present();
    },
    get children() {
      var k = ft(), n = k.firstChild, t = n.firstChild, i = t.firstChild, f = i.nextSibling;
      return Y(b, n), se(n, {
        "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": !0
      }), t.$$click = C, m(i, () => e.t("home.providerTip")), m(f, r(P, {
        name: "chevron-down",
        size: "small",
        class: "-rotate-90"
      })), m(n, r(ce, {
        class: "hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/provider-tip:delay-[250ms] group-hover/provider-tip:duration-150 group-hover/provider-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100",
        placement: "top",
        openDelay: 1e3,
        get value() {
          return e.t("common.dismiss");
        },
        get children() {
          var s = ht();
          return s.$$click = () => v("dismissedAt", Date.now()), m(s, r(P, {
            name: "xmark-small"
          })), I(() => _(s, "aria-label", e.t("common.dismiss"))), s;
        }
      }), null), I(() => _(n, "data-visible", u())), k;
    }
  });
}
ne(["click"]);
function wt(e) {
  return e.enabled ? e.selected ? e.selected : e.projectWorktree && e.directory !== e.projectWorktree ? e.directory : "main" : "main";
}
function kt(e, o, c) {
  return e === "main" && c !== o ? c : e;
}
function St(e) {
  return e.worktree === "main" || e.worktree === "create" ? e.local : e.worktreeBranch(e.worktree) ?? e.local;
}
function $t() {
  const e = E(), o = oe(), c = Z(), [l, a] = F(), d = V(() => o().project?.vcs === "git"), v = V(
    () => wt({
      enabled: d(),
      selected: l(),
      directory: e().directory,
      projectWorktree: o().project?.worktree
    })
  ), g = V(() => o().project?.worktree ?? e().directory), u = V(() => c().child(g())[0].vcs?.branch), h = V(
    () => St({
      worktree: v(),
      local: u(),
      worktreeBranch: (b) => c().child(b)[0].vcs?.branch
    })
  );
  return {
    selection: {
      value: v,
      reset: () => a(),
      set: (b) => a(kt(b, e().directory, o().project?.worktree))
    },
    project: {
      root: g,
      workspaces: () => o().project?.sandboxes ?? [],
      git: () => o().project?.vcs === "git"
    },
    bar: {
      visible: d,
      branch: h
    }
  };
}
function Ct(e) {
  const o = Oe(), c = ie(), l = A();
  Fe(), o.register("new-session", () => [{
    id: "command.palette",
    title: l.t("command.palette"),
    hidden: !0,
    onSelect: async () => {
      const {
        DialogSelectFile: a
      } = await import("./dialog-select-file-D5WJ9IED.js");
      c.show(() => r(a, {}));
    }
  }, {
    id: "input.focus",
    title: l.t("command.input.focus"),
    category: l.t("command.category.view"),
    keybind: "ctrl+l",
    onSelect: e.restoreFocus
  }, {
    id: "project.select",
    title: l.t("session.new.project.search"),
    category: l.t("command.category.project"),
    keybind: "mod+shift+o",
    disabled: e.project.empty(),
    onSelect: e.project.open
  }]);
}
var jt = /* @__PURE__ */ p('<div class="relative size-full overflow-hidden flex flex-col"><div class="flex-1 min-h-0 flex flex-col gap-2 p-2">');
function Pt() {
  const e = Ne(), o = We(), c = $t(), l = at({
    worktree: c.selection.value,
    resetWorktree: c.selection.reset
  }), a = Ye({
    controls: l.project.controls,
    onDone: l.input.restoreFocus
  });
  Ct({
    restoreFocus: l.input.restoreFocus,
    project: {
      empty: a.empty,
      open: () => a.setOpen(!0)
    }
  }), N(() => {
    l.prompt.ready() && l.input.restoreFocus();
  });
  const d = Promise.resolve(), [v] = Ee(() => l.prompt.readyPromise() ?? d, (g) => g.then(() => !0));
  return (() => {
    var g = jt(), u = g.firstChild;
    return m(g, v, u), m(g, r(bt, {
      mount: o,
      get visible() {
        return e.visibility.status;
      }
    }), u), m(u, r(yt, {
      get input() {
        return l.input;
      },
      project: a,
      workspace: c
    })), g;
  })();
}
export {
  Pt as default
};
