import { cm as pe, bZ as J, cd as Q, c7 as U, bV as W, b$ as X, c4 as ee, ck as fe, cf as me, aw as te, bl as E, aC as $, b6 as n, at as e, a7 as b, ba as i, a2 as w, o as z, V as S, Y as re, Z as ae, I as se, aH as K, ao as R, bF as ne, B as le, aL as xe, bL as x, aR as ke } from "./skynet-element-dDv65e_D.js";
import { S as ye } from "./switch-BYCptXAS.js";
import { u as $e } from "./mcp-DZ-Jnddv.js";
var we = /* @__PURE__ */ x('<code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">'), ue = /* @__PURE__ */ x('<div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">'), B = /* @__PURE__ */ x('<div class="flex flex-col px-2 pb-2"><div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">'), ce = /* @__PURE__ */ x("<div class=flex-1>"), oe = /* @__PURE__ */ x('<button type=button class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left">'), ie = /* @__PURE__ */ x('<span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">'), H = /* @__PURE__ */ x('<div class="text-14-regular text-text-base text-center my-auto">'), Se = /* @__PURE__ */ x('<span class="text-11-regular text-text-weaker truncate">'), _e = /* @__PURE__ */ x('<button type=button class="flex items-center gap-2 w-full min-h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"><div></div><span class="flex flex-col min-w-0 flex-1"><span class="flex items-center gap-2 min-w-0"><span class="text-14-regular text-text-base truncate"></span></span></span><div>'), Ce = /* @__PURE__ */ x('<div class="flex items-center gap-2 w-full px-2 py-1"><div></div><span class="text-14-regular text-text-base truncate">'), Le = /* @__PURE__ */ x('<div class="flex items-center gap-2 w-full px-2 py-1"><div class="size-1.5 rounded-full shrink-0 bg-icon-success-base"></div><span class="text-14-regular text-text-base truncate">');
const De = (r, s) => {
  const l = r.split(s);
  return l.length === 1 ? r : [i(() => l[0]), (() => {
    var t = we();
    return n(t, s), t;
  })(), i(() => l.slice(1).join(s))];
}, ge = (r, s, l) => {
  if (!r.length) return r;
  const t = new Map(r.map((c, o) => [c, o])), g = (c) => c?.healthy === !0 ? 0 : c?.healthy === !1 ? 2 : 1;
  return r.slice().sort((c, o) => {
    if (S.key(c) === s) return -1;
    if (S.key(o) === s) return 1;
    const k = g(l[S.key(c)]) - g(l[S.key(o)]);
    return k !== 0 ? k : (t.get(c) ?? 0) - (t.get(o) ?? 0);
  });
}, de = (r) => {
  const [s, l] = xe({
    key: void 0,
    tick: 0
  });
  return te(() => {
    s.tick;
    let t = !1;
    const g = r?.();
    if (!g) {
      l("key", void 0), E(() => {
        t = !0;
      });
      return;
    }
    if (g instanceof Promise) {
      g.then((c) => {
        t || l("key", c ?? void 0);
      }), E(() => {
        t = !0;
      });
      return;
    }
    l("key", S.Key.make(g)), E(() => {
      t = !0;
    });
  }), {
    key: () => s.key,
    refresh: () => l("tick", (t) => t + 1)
  };
};
function Ee() {
  const r = J(), s = Q(), l = U(), t = W(), g = X(), c = ee();
  let o = 0, k = !1;
  E(() => {
    k = !0, o += 1;
  });
  const L = $(() => ge(r.servers.list(), s.key, r.servers.health)), P = de(l.getDefaultServer), M = $(() => L().map((D) => {
    const p = S.key(D);
    return {
      key: p,
      conn: D,
      health: r.servers.health[p],
      blocked: r.servers.health[p]?.healthy === !1,
      active: !!s.current && p === S.key(s.current),
      onSelect: () => {
        c("/"), queueMicrotask(() => s.setActive(p));
      }
    };
  }));
  return e(Pe, {
    get state() {
      return {
        servers: M,
        defaultKey: P.key,
        ariaLabel: g.t("status.popover.ariaLabel"),
        serversLabel: g.t("status.popover.tab.servers"),
        defaultLabel: g.t("common.default"),
        manageLabel: g.t("status.popover.action.manageServers"),
        onManage: () => {
          const D = ++o;
          import("./skynet-element-dDv65e_D.js").then((p) => p.aS).then((p) => {
            k || o !== D || t.show(() => e(p.DialogSelectServer, {}), P.refresh);
          });
        }
      };
    }
  });
}
function Pe(r) {
  return (() => {
    var s = ue();
    return n(s, e(b, {
      get "aria-label"() {
        return r.state.ariaLabel;
      },
      class: "tabs bg-background-strong rounded-xl overflow-hidden",
      "data-component": "tabs",
      "data-active": "servers",
      defaultValue: "servers",
      variant: "alt",
      get children() {
        return [e(b.List, {
          "data-slot": "tablist",
          class: "bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10",
          get children() {
            return e(b.Trigger, {
              value: "servers",
              "data-slot": "tab",
              class: "text-12-regular",
              get children() {
                return [i(() => i(() => r.state.servers().length > 0)() ? `${r.state.servers().length} ` : ""), i(() => r.state.serversLabel)];
              }
            });
          }
        }), e(b.Content, {
          value: "servers",
          get children() {
            return e(Me, {
              get state() {
                return r.state;
              }
            });
          }
        })];
      }
    })), s;
  })();
}
function Me(r) {
  return (() => {
    var s = B(), l = s.firstChild;
    return n(l, e(z, {
      get each() {
        return r.state.servers();
      },
      children: (t) => (() => {
        var g = oe();
        return g.$$click = () => {
          t.blocked || t.onSelect();
        }, n(g, e(re, {
          get health() {
            return t.health;
          }
        }), null), n(g, e(ae, {
          get conn() {
            return t.conn;
          },
          get dimmed() {
            return t.blocked;
          },
          get status() {
            return t.health;
          },
          class: "flex items-center gap-2 w-full min-w-0",
          nameClass: "text-14-regular text-text-base truncate",
          versionClass: "text-12-regular text-text-weak truncate",
          get badge() {
            return e(w, {
              get when() {
                return t.key === r.state.defaultKey();
              },
              get children() {
                var c = ie();
                return n(c, () => r.state.defaultLabel), c;
              }
            });
          },
          get children() {
            return [ce(), e(w, {
              get when() {
                return t.active;
              },
              get children() {
                return e(se, {
                  name: "check",
                  size: "small",
                  class: "text-icon-weak shrink-0"
                });
              }
            })];
          }
        }), null), K((c) => {
          var o = {
            "hover:bg-surface-raised-base-hover": !t.blocked,
            "cursor-not-allowed": t.blocked
          }, k = t.blocked;
          return c.e = R(g, o, c.e), k !== c.t && ne(g, "aria-disabled", c.t = k), c;
        }, {
          e: void 0,
          t: void 0
        }), g;
      })()
    }), null), n(l, e(le, {
      variant: "secondary",
      class: "mt-3 self-start h-8 px-3 py-1.5",
      get onClick() {
        return r.state.onManage;
      },
      get children() {
        return r.state.manageLabel;
      }
    }), null), s;
  })();
}
function Ie(r) {
  const s = pe(), l = J(), t = Q(), g = U(), c = W(), o = X(), k = ee(), L = fe(), P = me();
  te(() => {
    r.shown();
  });
  let M = 0, D = !1;
  E(() => {
    D = !0, M += 1;
  });
  const p = $(() => {
    const h = L.general.newLayoutDesigns() ? l.servers.list() : l.servers.list().filter((d) => l.ensureServerCtx(d).sdk.protocolKind() !== "v2");
    return ge(h, t.key, l.servers.health);
  }), _ = $e(), q = de(g.getDefaultServer), V = $(() => Object.keys(s().data.mcp ?? {}).sort((h, d) => h.localeCompare(d))), F = (h) => s().data.mcp?.[h]?.status, N = $(() => V().filter((h) => F(h) === "connected").length), A = $(() => s().data.lsp ?? []), Z = $(() => A().length), j = $(() => (s().data.config.plugin ?? []).map((h) => typeof h == "string" ? h : h[0])), G = $(() => j().length), ve = $(() => De(o.t("dialog.plugins.empty"), "opencode.json"));
  return (() => {
    var h = ue();
    return n(h, e(b, {
      get "aria-label"() {
        return o.t("status.popover.ariaLabel");
      },
      class: "tabs bg-background-strong rounded-xl overflow-hidden",
      "data-component": "tabs",
      get "data-active"() {
        return L.general.newLayoutDesigns() ? "mcp" : "servers";
      },
      get defaultValue() {
        return L.general.newLayoutDesigns() ? "mcp" : "servers";
      },
      variant: "alt",
      get children() {
        return [e(b.List, {
          "data-slot": "tablist",
          class: "bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10",
          get children() {
            return [i(() => i(() => !L.general.newLayoutDesigns())() && e(b.Trigger, {
              value: "servers",
              "data-slot": "tab",
              class: "text-12-regular",
              get children() {
                return [i(() => i(() => p().length > 0)() ? `${p().length} ` : ""), i(() => o.t("status.popover.tab.servers"))];
              }
            })), e(b.Trigger, {
              value: "mcp",
              "data-slot": "tab",
              class: "text-12-regular",
              get children() {
                return [i(() => i(() => N() > 0)() ? `${N()} ` : ""), i(() => o.t("status.popover.tab.mcp"))];
              }
            }), e(b.Trigger, {
              value: "lsp",
              "data-slot": "tab",
              class: "text-12-regular",
              get children() {
                return [i(() => i(() => Z() > 0)() ? `${Z()} ` : ""), i(() => o.t("status.popover.tab.lsp"))];
              }
            }), e(w, {
              get when() {
                return P() === "v1";
              },
              get children() {
                return e(b.Trigger, {
                  value: "plugins",
                  "data-slot": "tab",
                  class: "text-12-regular",
                  get children() {
                    return [i(() => i(() => G() > 0)() ? `${G()} ` : ""), i(() => o.t("status.popover.tab.plugins"))];
                  }
                });
              }
            })];
          }
        }), i(() => i(() => !L.general.newLayoutDesigns())() && e(b.Content, {
          value: "servers",
          get children() {
            var d = B(), C = d.firstChild;
            return n(C, e(z, {
              get each() {
                return p();
              },
              children: (a) => {
                const u = S.key(a), m = () => l.servers.health[u]?.healthy === !1;
                return (() => {
                  var v = oe();
                  return v.$$click = () => {
                    m() || (k("/"), queueMicrotask(() => t.setActive(u)));
                  }, n(v, e(re, {
                    get health() {
                      return l.servers.health[u];
                    }
                  }), null), n(v, e(ae, {
                    conn: a,
                    get dimmed() {
                      return m();
                    },
                    get status() {
                      return l.servers.health[u];
                    },
                    class: "flex items-center gap-2 w-full min-w-0",
                    nameClass: "text-14-regular text-text-base truncate",
                    versionClass: "text-12-regular text-text-weak truncate",
                    get badge() {
                      return e(w, {
                        get when() {
                          return u === q.key();
                        },
                        get children() {
                          var f = ie();
                          return n(f, () => o.t("common.default")), f;
                        }
                      });
                    },
                    get children() {
                      return [ce(), e(w, {
                        get when() {
                          return i(() => !!t.current)() && u === S.key(t.current);
                        },
                        get children() {
                          return e(se, {
                            name: "check",
                            size: "small",
                            class: "text-icon-weak shrink-0"
                          });
                        }
                      })];
                    }
                  }), null), K((f) => {
                    var T = {
                      "hover:bg-surface-raised-base-hover": !m(),
                      "cursor-not-allowed": m()
                    }, I = m();
                    return f.e = R(v, T, f.e), I !== f.t && ne(v, "aria-disabled", f.t = I), f;
                  }, {
                    e: void 0,
                    t: void 0
                  }), v;
                })();
              }
            }), null), n(C, e(le, {
              variant: "secondary",
              class: "mt-3 self-start h-8 px-3 py-1.5",
              onClick: () => {
                const a = ++M;
                import("./skynet-element-dDv65e_D.js").then((u) => u.aS).then((u) => {
                  D || M !== a || c.show(() => e(u.DialogSelectServer, {}), q.refresh);
                });
              },
              get children() {
                return o.t("status.popover.action.manageServers");
              }
            }), null), d;
          }
        })), e(b.Content, {
          value: "mcp",
          get children() {
            var d = B(), C = d.firstChild;
            return n(C, e(w, {
              get when() {
                return V().length > 0;
              },
              get fallback() {
                return (() => {
                  var a = H();
                  return n(a, () => o.t("dialog.mcp.empty")), a;
                })();
              },
              get children() {
                return e(z, {
                  get each() {
                    return V();
                  },
                  children: (a) => {
                    const u = () => F(a), m = () => u() === "connected";
                    return (() => {
                      var v = _e(), f = v.firstChild, T = f.nextSibling, I = T.firstChild, he = I.firstChild, O = T.nextSibling;
                      return v.$$click = () => {
                        _.isPending || _.mutate(a);
                      }, n(he, a), n(T, e(w, {
                        get when() {
                          return u() === "needs_auth";
                        },
                        get children() {
                          var y = Se();
                          return n(y, () => o.t("mcp.auth.clickToAuthenticate")), y;
                        }
                      }), null), O.$$click = (y) => y.stopPropagation(), n(O, e(ye, {
                        get checked() {
                          return m();
                        },
                        get disabled() {
                          return i(() => !!_.isPending)() && _.variables === a;
                        },
                        onChange: () => {
                          _.isPending || _.mutate(a);
                        }
                      })), K((y) => {
                        var Y = _.isPending && _.variables === a, be = {
                          "size-1.5 rounded-full shrink-0": !0,
                          "bg-icon-success-base": u() === "connected",
                          "bg-icon-critical-base": u() === "failed",
                          "bg-border-weak-base": u() === "disabled",
                          "bg-icon-warning-base": u() === "needs_auth" || u() === "needs_client_registration"
                        };
                        return Y !== y.e && (v.disabled = y.e = Y), y.t = R(f, be, y.t), y;
                      }, {
                        e: void 0,
                        t: void 0
                      }), v;
                    })();
                  }
                });
              }
            })), d;
          }
        }), e(b.Content, {
          value: "lsp",
          get children() {
            var d = B(), C = d.firstChild;
            return n(C, e(w, {
              get when() {
                return A().length > 0;
              },
              get fallback() {
                return (() => {
                  var a = H();
                  return n(a, () => o.t("dialog.lsp.empty")), a;
                })();
              },
              get children() {
                return e(z, {
                  get each() {
                    return A();
                  },
                  children: (a) => (() => {
                    var u = Ce(), m = u.firstChild, v = m.nextSibling;
                    return n(v, () => a.name || a.id), K((f) => R(m, {
                      "size-1.5 rounded-full shrink-0": !0,
                      "bg-icon-success-base": a.status === "connected",
                      "bg-icon-critical-base": a.status === "error"
                    }, f)), u;
                  })()
                });
              }
            })), d;
          }
        }), e(w, {
          get when() {
            return P() === "v1";
          },
          get children() {
            return e(b.Content, {
              value: "plugins",
              get children() {
                var d = B(), C = d.firstChild;
                return n(C, e(w, {
                  get when() {
                    return j().length > 0;
                  },
                  get fallback() {
                    return (() => {
                      var a = H();
                      return n(a, ve), a;
                    })();
                  },
                  get children() {
                    return e(z, {
                      get each() {
                        return j();
                      },
                      children: (a) => (() => {
                        var u = Le(), m = u.firstChild, v = m.nextSibling;
                        return n(v, a), u;
                      })()
                    });
                  }
                })), d;
              }
            });
          }
        })];
      }
    })), h;
  })();
}
ke(["click"]);
export {
  Ie as StatusPopoverBody,
  Ee as StatusPopoverServerBody
};
