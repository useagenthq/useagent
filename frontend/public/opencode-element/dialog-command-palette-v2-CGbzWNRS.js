import { bl as L, bk as ie, bz as R, aT as le, b0 as X, bR as Y, bZ as G, b$ as V, bW as J, bV as Q, cg as ce, cn as U, cj as Z, aC as _, as as ee, aJ as de, V as te, c0 as ue, at as d, aK as K, aI as me, aw as q, d as ge, b6 as p, ab as ve, t as fe, O as pe, a2 as I, o as z, ba as H, c as he, bL as $, ai as ye, M as N, w as be, aX as we, a1 as $e, aH as x, n as Se, a$ as _e, a5 as De, bF as B, aR as Ce } from "./skynet-element-dDv65e_D.js";
function Ie(e, n) {
  const s = new Date(e), r = (/* @__PURE__ */ new Date()).getTime() - s.getTime(), o = Math.floor(r / 1e3), a = Math.floor(o / 60), l = Math.floor(a / 60), g = Math.floor(l / 24);
  return o < 60 ? n("common.time.justNow") : a < 60 ? n("common.time.minutesAgo.short", { count: a }) : l < 24 ? n("common.time.hoursAgo.short", { count: l }) : n("common.time.daysAgo.short", { count: g });
}
const A = 5, Te = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle"
];
function ke(e) {
  const n = /* @__PURE__ */ new Set();
  return e.filter((s) => n.has(s.id) ? !1 : (n.add(s.id), !0));
}
function O(e, n) {
  return {
    id: "file:" + e,
    type: "file",
    title: e,
    category: n,
    path: e
  };
}
function Ee(e) {
  const n = J(), s = ue(), { tabs: t, view: r } = Z();
  return (o) => {
    const a = n.tab(o);
    t().open(a), n.load(o), r().reviewPanel.opened() || r().reviewPanel.open(), s.fileTree.setTab("all"), e?.(o), t().setActive(a);
  };
}
function Me(e) {
  const n = Y(), s = G(), t = V(), r = J(), o = Q(), a = ce()(), l = s.ensureServerCtx(a.server), g = U(), { tabs: v } = Z(), m = Ee(e.onOpenFile), h = { cleanup: void 0, committed: !1 }, f = () => e.filesOnly?.() ?? !1, b = _(() => f() ? [] : ee(n.options)), k = _(() => {
    const i = t.t("palette.group.commands");
    return b().map((u) => j(u, i));
  }), c = _(() => {
    const i = b(), u = new Map(Te.map((T, P) => [T, P])), C = i.filter((T) => u.has(T.id)), E = C.length ? C : i.slice(0, A), F = C.length ? [...E].sort((T, P) => (u.get(T.id) ?? 0) - (u.get(P.id) ?? 0)) : E, S = t.t("palette.group.commands");
    return F.map((T) => j(T, S));
  }), y = de({
    tabs: v,
    pathFromTab: r.pathFromTab,
    normalizeTab: (i) => i.startsWith("file://") ? r.tab(i) : i
  }), D = _(() => {
    const i = y.openedTabs(), u = y.activeFileTab(), C = u ? [u, ...i.filter((S) => S !== u)] : i, E = /* @__PURE__ */ new Set(), F = t.t("palette.group.files");
    return C.map((S) => r.pathFromTab(S)).filter((S) => !S || E.has(S) ? !1 : (E.add(S), !0)).slice(0, A).map((S) => O(S, F));
  }), w = _(() => {
    const i = t.t("palette.group.files");
    return r.tree.children("").filter((u) => u.type === "file").map((u) => u.path).sort((u, C) => u.localeCompare(C)).slice(0, A).map((u) => O(u, i));
  }), M = ne({
    server: te.key(a.server),
    opened: l.projects.list,
    stored: () => l.sync.data.project,
    load: (i, u) => a.api.session.list({ parentID: null, search: i, limit: 50 }, { signal: u }),
    untitled: () => t.t("command.session.new"),
    category: () => t.t("command.category.session")
  }), se = (i) => {
    h.cleanup?.(), h.cleanup = void 0, i?.type === "command" && (h.cleanup = i.option?.onHighlight?.());
  }, oe = (i) => {
    if (i) {
      if (h.committed = !0, h.cleanup = void 0, o.close(), i.type === "command") {
        i.option?.onSelect?.("palette");
        return;
      }
      if (i.type === "session") {
        if (!i.sessionID || !i.server) return;
        const u = i.project?.worktree ?? i.directory;
        u && (l.projects.open(u), l.projects.touch(u));
        const C = g.addSessionTab({
          server: i.server,
          sessionId: i.sessionID
        });
        g.select(C);
        return;
      }
      i.path && m(i.path);
    }
  };
  return L(() => {
    h.committed || h.cleanup?.();
  }), {
    language: t,
    file: r,
    commandEntries: k,
    preferredCommandEntries: c,
    recentFileEntries: D,
    rootFileEntries: w,
    sessions: M,
    highlight: se,
    select: oe,
    close: () => o.close()
  };
}
function j(e, n) {
  return {
    id: "command:" + e.id,
    type: "command",
    title: e.title,
    description: e.description,
    keybind: e.keybind,
    category: n,
    option: e
  };
}
function ne(e) {
  let n;
  return L(() => n?.abort()), async (s) => {
    const t = s.trim();
    if (!t)
      return n?.abort(), [];
    n?.abort();
    const r = new AbortController();
    if (n = r, await new Promise((v) => {
      const m = setTimeout(v, 100);
      r.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(m), v();
        },
        { once: !0 }
      );
    }), r.signal.aborted) return [];
    const o = e.opened(), a = new Map(o.flatMap((v) => v.id ? [[v.id, v]] : [])), l = e.stored().map((v) => ({ ...v, expanded: !1 })), g = new Map(l.map((v) => [v.id, v]));
    return e.load(t, r.signal).then(
      (v) => v.data.map(ie).filter((m) => !m.time.archived).map((m) => {
        const h = R(m, o, a) ?? R(m, l, g);
        return {
          id: `session:${e.server}:${m.id}`,
          type: "session",
          title: m.title || e.untitled(),
          description: h ? le(h) : X(m.directory),
          category: e.category(),
          directory: m.directory,
          sessionID: m.id,
          server: e.server,
          project: h,
          updated: m.time.updated
        };
      })
    ).catch(() => []);
  };
}
var Fe = /* @__PURE__ */ $("<div class=command-palette-v2-search>"), Pe = /* @__PURE__ */ $("<div class=command-palette-v2-results role=listbox>"), xe = /* @__PURE__ */ $("<div class=command-palette-v2-state>"), Ae = /* @__PURE__ */ $("<div class=command-palette-v2-group-title>"), Oe = /* @__PURE__ */ $("<div class=command-palette-v2-group>"), W = /* @__PURE__ */ $("<span class=command-palette-v2-description>"), je = /* @__PURE__ */ $("<div class=command-palette-v2-row-main><div class=command-palette-v2-row-text><span class=command-palette-v2-title>"), Le = /* @__PURE__ */ $('<span aria-hidden=true class="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"style="right:calc(100% + 4px)">'), Ve = /* @__PURE__ */ $('<div class=command-palette-v2-row-main><div class="relative shrink-0"></div><div class=command-palette-v2-row-text><span class=command-palette-v2-title>'), Re = /* @__PURE__ */ $("<span class=command-palette-v2-meta>"), Ke = /* @__PURE__ */ $('<button type=button class="command-palette-v2-row group"role=option>'), qe = /* @__PURE__ */ $("<div class=command-palette-v2-row-main><div class=command-palette-v2-file-path><span class=command-palette-v2-file-dir></span><span class=command-palette-v2-file-name>");
function ze(e) {
  const n = /* @__PURE__ */ new Map();
  for (const s of e) n.set(s.category, [...n.get(s.category) ?? [], s]);
  return Array.from(n.entries()).map(([s, t]) => ({
    category: s,
    entries: t
  }));
}
function re(e, n) {
  const s = n.toLowerCase();
  return [e.title, e.description, e.category].some((t) => t?.toLowerCase().includes(s));
}
function He(e) {
  const n = Me(e);
  return d(ae, {
    get placeholder() {
      return n.language.t("palette.search.placeholder");
    },
    loadItems: async (t) => {
      const r = t.trim();
      if (!r) return [...n.preferredCommandEntries(), ...n.recentFileEntries()];
      const [o, a] = await Promise.all([n.file.searchFiles(r), Promise.resolve(n.sessions(r))]), l = n.language.t("palette.group.files");
      return [...n.commandEntries().filter((g) => re(g, r)), ...a, ...o.map((g) => O(g, l))];
    },
    get highlight() {
      return n.highlight;
    },
    get select() {
      return n.select;
    },
    get close() {
      return n.close;
    }
  });
}
function Ne(e) {
  const n = Y(), s = Q(), t = G(), r = V(), o = t.ensureServerCtx(e.server), a = {
    cleanup: void 0,
    committed: !1
  }, l = _(() => {
    const f = r.t("palette.group.commands");
    return ee(n.options).map((b) => j(b, f));
  }), g = ne({
    server: te.key(e.server),
    opened: o.projects.list,
    stored: () => o.sync.data.project,
    load: (f, b) => o.sdk.api.session.list({
      parentID: null,
      search: f,
      limit: 50
    }, {
      signal: b
    }),
    untitled: () => r.t("command.session.new"),
    category: () => r.t("command.category.session")
  }), v = (f) => {
    a.cleanup?.(), a.cleanup = void 0, f?.type === "command" && (a.cleanup = f.option?.onHighlight?.());
  }, m = (f) => {
    if (f) {
      if (a.committed = !0, a.cleanup = void 0, s.close(), f.type === "command") {
        f.option?.onSelect?.("palette");
        return;
      }
      f.type === "session" && e.onSelectSession(f);
    }
  }, h = async (f) => {
    const b = f.trim();
    return b ? [...l().filter((k) => re(k, b)), ...await g(b)] : l().slice(0, 5);
  };
  return L(() => {
    a.committed || a.cleanup?.();
  }), d(ae, {
    get placeholder() {
      return r.t("palette.search.placeholder.home");
    },
    loadItems: h,
    highlight: v,
    select: m,
    close: () => s.close()
  });
}
function ae(e) {
  const n = V(), s = U(), [t, r] = K(""), [o, a] = K(0), [l] = me(t, e.loadItems, {
    initialValue: []
  }), g = _(() => ke(l.latest ?? [])), v = _(() => ze(g())), m = _(() => g()[o()]), h = _(() => new Set(s.store.flatMap((c) => c.type === "session" ? [`${c.server}\0${c.sessionId}`] : [])));
  q(() => {
    t(), g(), a(0);
  }), q(() => {
    e.highlight(m());
  });
  let f;
  const b = (c) => {
    const y = g().length;
    y !== 0 && (a((D) => (D + c + y) % y), requestAnimationFrame(() => {
      f?.querySelector("[data-active]")?.scrollIntoView({
        block: "nearest"
      });
    }));
  }, k = (c) => {
    if (c.key === "ArrowDown") {
      c.preventDefault(), b(1);
      return;
    }
    if (c.key === "ArrowUp") {
      c.preventDefault(), b(-1);
      return;
    }
    if (c.key === "Enter") {
      c.preventDefault(), e.select(m());
      return;
    }
    c.key === "Escape" && (c.preventDefault(), e.close());
  };
  return d(he, {
    class: "command-palette-v2",
    size: "large",
    get children() {
      return d(ge, {
        class: "command-palette-v2-body",
        get children() {
          return [(() => {
            var c = Fe();
            return p(c, d(ve, {
              get value() {
                return t();
              },
              autofocus: !0,
              autocomplete: "off",
              spellcheck: !1,
              appearance: "large",
              get placeholder() {
                return e.placeholder;
              },
              get leadingIcon() {
                return d(fe, {
                  name: "magnifying-glass"
                });
              },
              onInput: (y) => r(y.currentTarget.value),
              onKeyDown: k
            })), c;
          })(), d(pe, {
            class: "command-palette-v2-scroll",
            viewportRef: (c) => f = c,
            get children() {
              var c = Pe();
              return p(c, d(I, {
                get when() {
                  return g().length > 0;
                },
                get fallback() {
                  return (() => {
                    var y = xe();
                    return p(y, (() => {
                      var D = H(() => !!l.loading);
                      return () => D() ? n.t("common.loading") : n.t("palette.empty");
                    })()), y;
                  })();
                },
                get children() {
                  return d(z, {
                    get each() {
                      return v();
                    },
                    children: (y) => (() => {
                      var D = Oe();
                      return p(D, d(I, {
                        get when() {
                          return y.category;
                        },
                        get children() {
                          var w = Ae();
                          return p(w, () => y.category), w;
                        }
                      }), null), p(D, d(z, {
                        get each() {
                          return y.entries;
                        },
                        children: (w) => d(Be, {
                          item: w,
                          get active() {
                            return m()?.id === w.id;
                          },
                          language: n,
                          get sessionOpen() {
                            return H(() => !!(w.server && w.sessionID))() ? h().has(`${w.server}\0${w.sessionID}`) : !1;
                          },
                          onActive: () => a(g().findIndex((M) => M.id === w.id)),
                          onSelect: () => e.select(w)
                        })
                      }), null), D;
                    })()
                  });
                }
              })), c;
            }
          })];
        }
      });
    }
  });
}
function Be(e) {
  const n = () => e.item.server && e.item.directory && e.item.sessionID ? {
    server: e.item.server,
    directory: e.item.directory,
    sessionID: e.item.sessionID
  } : void 0;
  return (() => {
    var s = Ke();
    return ye(s, "click", e.onSelect, !0), s.$$mousedown = (t) => t.preventDefault(), s.$$mousemove = (t) => {
      t.movementX === 0 && t.movementY === 0 || e.onActive();
    }, p(s, d(De, {
      get fallback() {
        return (() => {
          var t = qe(), r = t.firstChild, o = r.firstChild, a = o.nextSibling;
          return p(t, d(Se, {
            get node() {
              return {
                path: e.item.path ?? "",
                type: "file"
              };
            },
            class: "command-palette-v2-row-icon size-4"
          }), r), p(o, () => _e(e.item.path ?? "")), p(a, () => X(e.item.path ?? "")), t;
        })();
      },
      get children() {
        return [d(N, {
          get when() {
            return e.item.type === "command";
          },
          get children() {
            return [(() => {
              var t = je(), r = t.firstChild, o = r.firstChild;
              return p(o, () => e.item.title), p(r, d(I, {
                get when() {
                  return e.item.description;
                },
                get children() {
                  var a = W();
                  return p(a, () => e.item.description), a;
                }
              }), null), t;
            })(), d(I, {
              get when() {
                return e.item.keybind;
              },
              get children() {
                return d(be, {
                  get keys() {
                    return we(e.item.keybind ?? "", e.language.t);
                  },
                  variant: "neutral"
                });
              }
            })];
          }
        }), d(N, {
          get when() {
            return e.item.type === "session";
          },
          get children() {
            return [(() => {
              var t = Ve(), r = t.firstChild, o = r.nextSibling, a = o.firstChild;
              return p(r, d(I, {
                get when() {
                  return e.sessionOpen;
                },
                get children() {
                  return Le();
                }
              }), null), p(r, d(I, {
                get when() {
                  return n();
                },
                children: (l) => d($e, {
                  get project() {
                    return e.item.project;
                  },
                  get directory() {
                    return l().directory;
                  },
                  get sessionId() {
                    return l().sessionID;
                  },
                  get server() {
                    return l().server;
                  }
                })
              }), null), p(a, () => e.item.title), p(o, d(I, {
                get when() {
                  return e.item.description;
                },
                get children() {
                  var l = W();
                  return p(l, () => e.item.description), x(() => l.classList.toggle("opacity-70", !!e.item.archived)), l;
                }
              }), null), x(() => a.classList.toggle("opacity-70", !!e.item.archived)), t;
            })(), d(I, {
              get when() {
                return e.item.updated;
              },
              get children() {
                var t = Re();
                return p(t, () => Ie(new Date(e.item.updated).toISOString(), e.language.t)), t;
              }
            })];
          }
        })];
      }
    })), x((t) => {
      var r = e.active, o = e.active ? "" : void 0;
      return r !== t.e && B(s, "aria-selected", t.e = r), o !== t.t && B(s, "data-active", t.t = o), t;
    }, {
      e: void 0,
      t: void 0
    }), s;
  })();
}
Ce(["mousemove", "mousedown", "click"]);
const Xe = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DialogCommandPaletteV2: He,
  DialogHomeCommandPaletteV2: Ne
}, Symbol.toStringTag, { value: "Module" }));
export {
  He as D,
  Ee as a,
  Me as b,
  O as c,
  Xe as d,
  Ie as g,
  ke as u
};
