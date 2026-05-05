import { c7 as b, ck as _, at as r, b$ as S, cg as D, cj as C, aC as k, aQ as O, aK as E, L, a5 as P, M as y, b6 as s, a2 as h, K, aW as M, I as j, aH as x, n as I, a$ as V, b0 as z, b as q, b8 as R, bL as p } from "./skynet-element-dDv65e_D.js";
import { D as B, a as G, b as H, g as Q, u as v, c as F } from "./dialog-command-palette-v2-CGbzWNRS.js";
var $ = /* @__PURE__ */ p('<span class="text-14-regular text-text-weak truncate">'), T = /* @__PURE__ */ p('<div class="w-full flex items-center justify-between gap-4"><div class="flex items-center gap-2 min-w-0"><span class="text-14-regular text-text-strong whitespace-nowrap">'), W = /* @__PURE__ */ p('<span class="text-12-regular text-text-weak whitespace-nowrap ml-2">'), A = /* @__PURE__ */ p('<div class="w-full flex items-center justify-between rounded-md pl-1"><div class="flex items-center gap-x-3 grow min-w-0"><div class="flex items-center gap-2 min-w-0"><span class="text-14-regular text-text-strong truncate">'), J = /* @__PURE__ */ p('<div class="w-full flex items-center justify-between rounded-md pl-1"><div class="flex items-center gap-x-3 grow min-w-0"><div class="flex items-center text-14-regular"><span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0"></span><span class="text-text-strong whitespace-nowrap">');
const N = R(() => import("./dialog-select-directory-v2-6HyHfpKy.js").then((a) => ({
  default: a.DialogSelectDirectoryV2
})));
function ee(a) {
  const t = b(), u = _(), g = () => a.mode === "files";
  return !g() && u.general.newLayoutDesigns() ? r(B, {
    get onOpenFile() {
      return a.onOpenFile;
    }
  }) : g() && t.platform === "desktop" && u.general.newLayoutDesigns() ? r(U, {
    get onOpenFile() {
      return a.onOpenFile;
    }
  }) : r(X, {
    filesOnly: g,
    get onOpenFile() {
      return a.onOpenFile;
    }
  });
}
function U(a) {
  const t = S(), u = D(), {
    params: g
  } = C(), m = k(() => O(g.dir) ?? ""), e = G(a.onOpenFile);
  return r(N, {
    get server() {
      return u().server;
    },
    mode: "file",
    get start() {
      return m();
    },
    get title() {
      return t.t("session.header.searchFiles");
    },
    onSelect: (n) => {
      typeof n == "string" && e(n);
    }
  });
}
function X(a) {
  const t = H(a), [u, g] = E(!1), m = async (e) => {
    const n = e.trim();
    if (g(n.length > 0), !n && a.filesOnly()) {
      const d = t.file.tree.state("")?.loaded, w = d ? Promise.resolve() : t.file.tree.list(""), f = v([...t.recentFileEntries(), ...t.rootFileEntries()]);
      return d || f.length > 0 ? f : (await w, v([...t.recentFileEntries(), ...t.rootFileEntries()]));
    }
    if (!n) return [...t.preferredCommandEntries(), ...t.recentFileEntries()];
    if (a.filesOnly()) {
      const d = await t.file.searchFiles(n), w = t.language.t("palette.group.files");
      return d.map((f) => F(f, w));
    }
    const [l, i] = await Promise.all([t.file.searchFiles(n), Promise.resolve(t.sessions(n))]), o = t.language.t("palette.group.files"), c = l.map((d) => F(d, o));
    return [...t.commandEntries(), ...i, ...c];
  };
  return r(q, {
    class: "pt-3 pb-0 !max-h-[480px]",
    transition: !0,
    get children() {
      return r(L, {
        class: "px-3",
        get search() {
          return {
            placeholder: a.filesOnly() ? t.language.t("session.header.searchFiles") : t.language.t("palette.search.placeholder"),
            autofocus: !0,
            hideIcon: !0
          };
        },
        get emptyMessage() {
          return t.language.t("palette.empty");
        },
        get loadingMessage() {
          return t.language.t("common.loading");
        },
        items: m,
        key: (e) => e.id,
        filterKeys: ["title", "description", "category"],
        skipFilter: (e) => e.type === "file",
        get groupBy() {
          return u() ? (e) => e.category : () => "";
        },
        onMove: (e) => t.highlight(e),
        onSelect: (e) => t.select(e),
        children: (e) => r(P, {
          get fallback() {
            return (() => {
              var n = J(), l = n.firstChild, i = l.firstChild, o = i.firstChild, c = o.nextSibling;
              return s(l, r(I, {
                get node() {
                  return {
                    path: e.path ?? "",
                    type: "file"
                  };
                },
                class: "shrink-0 size-4"
              }), i), s(o, () => V(e.path ?? "")), s(c, () => z(e.path ?? "")), n;
            })();
          },
          get children() {
            return [r(y, {
              get when() {
                return e.type === "command";
              },
              get children() {
                var n = T(), l = n.firstChild, i = l.firstChild;
                return s(i, () => e.title), s(l, r(h, {
                  get when() {
                    return e.description;
                  },
                  get children() {
                    var o = $();
                    return s(o, () => e.description), o;
                  }
                }), null), s(n, r(h, {
                  get when() {
                    return e.keybind;
                  },
                  get children() {
                    return r(K, {
                      class: "rounded-[4px]",
                      get children() {
                        return M(e.keybind ?? "", t.language.t);
                      }
                    });
                  }
                }), null), n;
              }
            }), r(y, {
              get when() {
                return e.type === "session";
              },
              get children() {
                var n = A(), l = n.firstChild, i = l.firstChild, o = i.firstChild;
                return s(l, r(j, {
                  name: "bubble-5",
                  size: "small",
                  class: "shrink-0 text-icon-weak"
                }), i), s(o, () => e.title), s(i, r(h, {
                  get when() {
                    return e.description;
                  },
                  get children() {
                    var c = $();
                    return s(c, () => e.description), x(() => c.classList.toggle("opacity-70", !!e.archived)), c;
                  }
                }), null), s(n, r(h, {
                  get when() {
                    return e.updated;
                  },
                  get children() {
                    var c = W();
                    return s(c, () => Q(new Date(e.updated).toISOString(), t.language.t)), c;
                  }
                }), null), x(() => o.classList.toggle("opacity-70", !!e.archived)), n;
              }
            })];
          }
        })
      });
    }
  });
}
export {
  ee as DialogSelectFile
};
