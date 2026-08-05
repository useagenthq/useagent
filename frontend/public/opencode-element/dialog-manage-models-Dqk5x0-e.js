import { c1 as V, b$ as x, bV as L, at as l, L as M, b6 as s, ac as z, B as T, b as E, bX as G, bw as D, f as O, i as j, a as q, d as F, ab as H, a2 as h, v as K, t as N, o as C, N as Q, c as X, bL as c, aQ as S, aR as A } from "./skynet-element-dDv65e_D.js";
import { S as k } from "./switch-BYCptXAS.js";
import { a as w, S as J } from "./row-Bua87tJ-.js";
import { D as P } from "./dialog-connect-provider-IYJDJgf0.js";
import { S as U } from "./list-Oo9-qh94.js";
var W = /* @__PURE__ */ c("<span>"), Y = /* @__PURE__ */ c('<div class="w-full flex items-center justify-between gap-x-3"><span></span><div>'), Z = /* @__PURE__ */ c('<div class="px-4 pt-px pb-3"><div class=relative>'), ee = /* @__PURE__ */ c('<div data-slot=manage-models-scroll class="relative min-h-0 flex-1"><div class="settings-v2-panel settings-v2-models h-full px-4 pt-4 pb-4">'), te = /* @__PURE__ */ c("<div class=settings-v2-models-status>"), re = /* @__PURE__ */ c("<span class=settings-v2-models-status-filter>&quot;<!>&quot;"), ie = /* @__PURE__ */ c("<div class=settings-v2-models-status><span>"), le = /* @__PURE__ */ c('<div class=settings-v2-section data-component=settings-models-provider><div class="settings-v2-models-group-header justify-between"><div class="flex min-w-0 items-center gap-2"><h3 class=settings-v2-section-title></h3></div><div>'), oe = /* @__PURE__ */ c("<div>");
const ge = () => {
  const o = V(), n = x(), f = L(), b = () => S(o.slug()), $ = () => {
    f.show(() => l(P, {
      directory: b
    }));
  }, m = (t) => D.indexOf(t), v = (t) => o.model.list().filter((e) => e.provider.id === t), y = (t) => v(t).every((e) => o.model.visible({
    modelID: e.id,
    providerID: e.provider.id
  })), _ = (t, e) => {
    v(t).forEach((r) => {
      o.model.setVisibility({
        modelID: r.id,
        providerID: r.provider.id
      }, e);
    });
  };
  return l(E, {
    get title() {
      return n.t("dialog.model.manage");
    },
    get description() {
      return n.t("dialog.model.manage.description");
    },
    get action() {
      return l(T, {
        class: "h-7 -my-1 text-14-medium",
        icon: "plus-small",
        tabIndex: -1,
        onClick: $,
        get children() {
          return n.t("command.provider.connect");
        }
      });
    },
    get children() {
      return l(M, {
        class: "px-3",
        get search() {
          return {
            placeholder: n.t("dialog.model.search.placeholder"),
            autofocus: !0
          };
        },
        get emptyMessage() {
          return n.t("dialog.model.empty");
        },
        key: (t) => `${t?.provider?.id}:${t?.id}`,
        get items() {
          return o.model.list();
        },
        filterKeys: ["provider.name", "name", "id"],
        sortBy: (t, e) => t.name.localeCompare(e.name),
        groupBy: (t) => t.provider.id,
        groupHeader: (t) => {
          const e = t.items[0].provider;
          return [(() => {
            var r = W();
            return s(r, () => e.name), r;
          })(), l(z, {
            placement: "top",
            get value() {
              return n.t("dialog.model.manage.provider.toggle", {
                provider: e.name
              });
            },
            get children() {
              return l(k, {
                class: "-mr-1",
                get checked() {
                  return y(e.id);
                },
                onChange: (r) => _(e.id, r),
                hideLabel: !0,
                get children() {
                  return e.name;
                }
              });
            }
          })];
        },
        sortGroupsBy: (t, e) => {
          const r = m(t.items[0].provider.id), i = m(e.items[0].provider.id), a = r >= 0, d = i >= 0;
          return a && !d ? -1 : !a && d ? 1 : r - i;
        },
        onSelect: (t) => {
          if (!t) return;
          const e = {
            modelID: t.id,
            providerID: t.provider.id
          };
          o.model.setVisibility(e, !o.model.visible(e));
        },
        children: (t) => (() => {
          var e = Y(), r = e.firstChild, i = r.nextSibling;
          return s(r, () => t.name), i.$$click = (a) => a.stopPropagation(), s(i, l(k, {
            get checked() {
              return !!o.model.visible({
                modelID: t.id,
                providerID: t.provider.id
              });
            },
            onChange: (a) => {
              o.model.setVisibility({
                modelID: t.id,
                providerID: t.provider.id
              }, a);
            }
          })), e;
        })()
      });
    }
  });
}, ue = () => {
  const o = V(), n = x(), f = L(), b = () => S(o.slug()), $ = () => {
    f.show(() => l(P, {
      directory: b
    }));
  }, m = (e) => o.model.list().filter((r) => r.provider.id === e), v = (e) => m(e).every((r) => o.model.visible({
    modelID: r.id,
    providerID: r.provider.id
  })), y = (e, r) => {
    m(e).forEach((i) => {
      o.model.setVisibility({
        modelID: i.id,
        providerID: i.provider.id
      }, r);
    });
  }, _ = (e, r) => {
    o.model.setVisibility({
      modelID: e.id,
      providerID: e.provider.id
    }, r);
  }, t = G({
    items: () => o.model.list(),
    key: (e) => `${e.provider.id}:${e.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (e, r) => e.name.localeCompare(r.name),
    groupBy: (e) => e.provider.id,
    sortGroupsBy: (e, r) => {
      const i = D.indexOf(e.category), a = D.indexOf(r.category), d = i >= 0, g = a >= 0;
      return d && !g ? -1 : !d && g ? 1 : i - a;
    }
  });
  return l(X, {
    size: "large",
    variant: "settings",
    class: "settings-v2-manage-models-dialog",
    get children() {
      return [l(O, {
        hideClose: !0,
        get closeLabel() {
          return n.t("common.close");
        },
        get children() {
          return [l(j, {
            get title() {
              return n.t("dialog.model.manage");
            },
            get description() {
              return n.t("dialog.model.manage.description");
            }
          }), l(q, {
            variant: "neutral",
            icon: "plus",
            onClick: $,
            get children() {
              return n.t("command.provider.connect");
            }
          })];
        }
      }), l(F, {
        class: "flex min-h-0 flex-1 flex-col",
        get children() {
          return [(() => {
            var e = Z(), r = e.firstChild;
            return s(r, l(H, {
              type: "search",
              appearance: "base",
              class: "!w-full self-stretch",
              get value() {
                return t.filter();
              },
              onInput: (i) => t.onInput(i.currentTarget.value),
              get placeholder() {
                return n.t("dialog.model.search.placeholder");
              },
              spellcheck: !1,
              autocorrect: "off",
              autocomplete: "off",
              autocapitalize: "off",
              autofocus: !0,
              get "aria-label"() {
                return n.t("dialog.model.search.placeholder");
              }
            }), null), s(r, l(h, {
              get when() {
                return t.filter();
              },
              get children() {
                return l(K, {
                  type: "button",
                  variant: "ghost-muted",
                  size: "small",
                  class: "settings-v2-tab-search-clear",
                  get icon() {
                    return l(N, {
                      name: "close",
                      size: "large",
                      class: "text-v2-icon-icon-muted"
                    });
                  },
                  onClick: () => t.clear(),
                  get "aria-label"() {
                    return n.t("common.clear");
                  }
                });
              }
            }), null), e;
          })(), (() => {
            var e = ee(), r = e.firstChild;
            return s(r, l(h, {
              get when() {
                return !t.grouped.loading;
              },
              get fallback() {
                return (() => {
                  var i = te();
                  return s(i, () => n.t("common.loading"), null), s(i, () => n.t("common.loading.ellipsis"), null), i;
                })();
              },
              get children() {
                return l(h, {
                  get when() {
                    return t.flat().length > 0;
                  },
                  get fallback() {
                    return (() => {
                      var i = ie(), a = i.firstChild;
                      return s(a, () => n.t("dialog.model.empty")), s(i, l(h, {
                        get when() {
                          return t.filter();
                        },
                        get children() {
                          var d = re(), g = d.firstChild, p = g.nextSibling;
                          return p.nextSibling, s(d, () => t.filter(), p), d;
                        }
                      }), null), i;
                    })();
                  },
                  get children() {
                    return l(C, {
                      get each() {
                        return t.grouped.latest;
                      },
                      children: (i) => (() => {
                        var a = le(), d = a.firstChild, g = d.firstChild, p = g.firstChild, B = g.nextSibling;
                        return s(g, l(Q, {
                          get id() {
                            return i.category;
                          },
                          width: 16,
                          height: 16,
                          class: "ml-4 shrink-0"
                        }), p), s(p, () => i.items[0].provider.name), s(B, l(w, {
                          class: "mr-6",
                          get checked() {
                            return v(i.category);
                          },
                          onChange: (u) => y(i.category, u),
                          hideLabel: !0,
                          get children() {
                            return i.items[0].provider.name;
                          }
                        })), s(a, l(U, {
                          get children() {
                            return l(C, {
                              get each() {
                                return i.items;
                              },
                              children: (u) => l(J, {
                                get title() {
                                  return u.name;
                                },
                                description: "",
                                get children() {
                                  var I = oe();
                                  return s(I, l(w, {
                                    get checked() {
                                      return o.model.visible({
                                        modelID: u.id,
                                        providerID: u.provider.id
                                      });
                                    },
                                    onChange: (R) => _(u, R),
                                    hideLabel: !0,
                                    get children() {
                                      return u.name;
                                    }
                                  })), I;
                                }
                              })
                            });
                          }
                        }), null), a;
                      })()
                    });
                  }
                });
              }
            })), e;
          })()];
        }
      })];
    }
  });
};
A(["click"]);
export {
  ge as DialogManageModels,
  ue as DialogManageModelsV2
};
