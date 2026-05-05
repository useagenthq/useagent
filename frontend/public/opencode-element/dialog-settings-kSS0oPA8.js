import { co as Oe, b$ as J, c6 as Ve, c7 as _e, bV as pe, c5 as je, ck as he, aC as z, aQ as Me, ch as $e, cg as ye, aI as ce, bm as Re, b6 as r, at as e, a2 as w, bL as d, a9 as Ze, B as q, T as K, ba as W, aa as se, bB as Ke, bC as Ge, be as qe, bf as Ue, bM as Qe, bN as He, bc as ge, ac as We, I as j, bD as Xe, bg as Ye, bO as Je, S as et, bv as tt, bZ as me, l as G, Y as xe, V as te, Z as be, o as Y, $ as rt, a0 as nt, y as st, Q as it, cf as lt, ca as at, bw as le, N as ie, a8 as re, bG as ne, c2 as ot, bX as ct, u as gt, ce as dt, W as ut, X as pt, aK as ht, a7 as S, bK as mt, b as vt } from "./skynet-element-dDv65e_D.js";
import { S as $ } from "./switch-BYCptXAS.js";
import { u as ft, a as E, S as xt } from "./settings-keybinds-CZnVa_7L.js";
import { E as bt, u as wt, a as _t, D as $t } from "./dialog-connect-provider-IYJDJgf0.js";
var yt = /* @__PURE__ */ d("<div data-action=settings-new-layout-designs>"), de = /* @__PURE__ */ d('<div class="flex flex-col gap-1">'), Ct = /* @__PURE__ */ d('<span class="flex items-center gap-2">'), St = /* @__PURE__ */ d("<div data-action=settings-auto-accept-permissions>"), kt = /* @__PURE__ */ d("<div data-action=settings-feed-reasoning-summaries>"), Pt = /* @__PURE__ */ d("<div data-action=settings-feed-shell-tool-parts-expanded>"), Tt = /* @__PURE__ */ d("<div data-action=settings-feed-edit-tool-parts-expanded>"), Dt = /* @__PURE__ */ d("<div data-action=settings-show-file-tree>"), Ft = /* @__PURE__ */ d("<div data-action=settings-show-navigation>"), It = /* @__PURE__ */ d("<div data-action=settings-show-search>"), zt = /* @__PURE__ */ d("<div data-action=settings-show-status>"), Et = /* @__PURE__ */ d("<div data-action=settings-show-custom-agents>"), H = /* @__PURE__ */ d('<div class="flex flex-col gap-1"><h3 class="text-14-medium text-text-strong pb-2">'), ue = /* @__PURE__ */ d('<div class="w-full sm:w-[220px]">'), At = /* @__PURE__ */ d("<div data-action=settings-notifications-agent>"), Nt = /* @__PURE__ */ d("<div data-action=settings-notifications-permissions>"), Bt = /* @__PURE__ */ d("<div data-action=settings-notifications-errors>"), Lt = /* @__PURE__ */ d("<div data-action=settings-release-notes>"), Ot = /* @__PURE__ */ d("<div data-action=settings-pinch-zoom>"), Vt = /* @__PURE__ */ d("<div data-action=settings-wayland>"), jt = /* @__PURE__ */ d("<span class=text-text-weak>"), Mt = /* @__PURE__ */ d('<div class="flex items-center gap-2"><span>'), Rt = /* @__PURE__ */ d('<div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10"><div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]"><div class="flex flex-col gap-1 pt-6 pb-8"><h2 class="text-16-medium text-text-strong"></h2></div></div><div class="flex flex-col gap-8 w-full">'), Zt = /* @__PURE__ */ d('<div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap"><div class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="text-14-medium text-text-strong"></span><span class="text-12-regular text-text-weak"></span></div><div class="flex w-full justify-end sm:w-auto sm:shrink-0">');
let M = {
  cleanup: void 0,
  timeout: void 0,
  run: 0
};
const Ce = () => {
  M.run += 1, M.cleanup && M.cleanup(), clearTimeout(M.timeout), M.cleanup = void 0;
}, we = (i) => {
  if (Ce(), !i) return;
  const t = ++M.run;
  M.timeout = setTimeout(() => {
    tt(i).then((a) => {
      if (M.run !== t) {
        a?.();
        return;
      }
      M.cleanup = a;
    });
  }, 100);
}, Kt = () => {
  const i = Oe(), t = J(), a = Ve(), c = _e(), v = pe(), m = je(), l = he(), _ = ft(), y = z(() => c.platform === "desktop" && c.os === "linux"), k = z(() => Me(m.dir)), P = z(() => {
    const o = k();
    return o ? m.id ? a.isAutoAccepting(m.id, o) : a.isAutoAcceptingDirectory(o) : !1;
  }), T = (o) => {
    const s = k();
    if (s) {
      if (!m.id) {
        if (a.isAutoAcceptingDirectory(s) === o) return;
        a.toggleAutoAcceptDirectory(s);
        return;
      }
      if (o) {
        a.enableAutoAccept(m.id, s);
        return;
      }
      a.disableAutoAccept(m.id, s);
    }
  }, A = z(() => c.platform === "desktop"), N = z(() => i.ids().map((o) => ({
    id: o,
    name: i.name(o)
  }))), F = $e(), B = ye(), [O] = ce(async () => {
    const o = B();
    return await o.protocol === "v1" ? (await o.client.pty.shells()).data ?? [] : [];
  }, {
    initialValue: []
  }), [U, {
    refetch: h
  }] = ce(() => !!(y() && c.getDisplayBackend), () => Promise.resolve(c.getDisplayBackend?.() ?? null).catch(() => null), {
    initialValue: null
  }), [u, {
    mutate: b
  }] = ce(() => !!(A() && c.getPinchZoomEnabled), () => Promise.resolve(c.getPinchZoomEnabled?.() ?? !1).catch(() => !1), {
    initialValue: !1
  });
  Re(() => {
    i.loadThemes();
  });
  const L = {
    id: "auto",
    value: "",
    label: t.t("settings.general.row.shell.autoDefault")
  }, R = z(() => F().data.config.shell ?? ""), Z = z(() => {
    const o = O.latest, s = F().data.config.shell, n = /* @__PURE__ */ new Map();
    for (const g of o)
      n.set(g.name, (n.get(g.name) || 0) + 1);
    const p = [L, ...o.map((g) => {
      const ve = (n.get(g.name) || 0) > 1, fe = ve ? g.path : g.name, Le = g.acceptable ? fe : `${fe} (${t.t("settings.general.row.shell.terminalOnly")})`;
      return {
        id: g.path,
        // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
        value: ve ? g.path : g.name,
        label: Le
      };
    })];
    return s && !p.some((g) => g.value === s) && p.push({
      id: s,
      value: s,
      label: s
    }), p;
  }), ae = (o) => {
    const s = c.setDisplayBackend?.(o ? "wayland" : "auto");
    s && s.finally(() => {
      h();
    });
  }, X = (o) => {
    b(o);
    const s = c.setPinchZoomEnabled?.(o);
    s && s.catch(() => b(!o));
  }, ee = z(() => [{
    value: "system",
    label: t.t("theme.scheme.system")
  }, {
    value: "light",
    label: t.t("theme.scheme.light")
  }, {
    value: "dark",
    label: t.t("theme.scheme.dark")
  }]), x = z(() => t.locales.map((o) => ({
    value: o,
    label: t.label(o)
  }))), D = {
    id: "none",
    label: "sound.option.none"
  }, C = [D, ...et], I = () => Ye(l.appearance.font()), V = () => Xe(l.appearance.uiFont()), oe = () => Je(l.appearance.terminalFont()), Q = (o, s, n, p) => ({
    options: C,
    current: o() ? C.find((g) => g.id === s()) ?? D : D,
    value: (g) => g.id,
    label: (g) => t.t(g.label),
    onHighlight: (g) => {
      g && we(g.id === "none" ? void 0 : g.id);
    },
    onSelect: (g) => {
      if (g) {
        if (g.id === "none") {
          n(!1), Ce();
          return;
        }
        n(!0), p(g.id), we(g.id);
      }
    },
    variant: "secondary",
    size: "small",
    triggerVariant: "settings"
  }), Te = () => (() => {
    var o = de();
    return r(o, e(E, {
      get children() {
        return e(f, {
          get title() {
            return (() => {
              var s = Ct();
              return r(s, () => t.t("settings.general.row.newInterface.title"), null), r(s, e(Ze, {
                variant: "accent",
                get children() {
                  return t.t("settings.general.row.newInterface.badge");
                }
              }), null), s;
            })();
          },
          get description() {
            return t.t("settings.general.row.newInterface.description");
          },
          get children() {
            var s = yt();
            return r(s, e($, {
              get checked() {
                return l.general.newLayoutDesigns();
              },
              onChange: (n) => {
                l.general.setNewLayoutDesigns(n), n && import("./index-CCerNFou.js").then((p) => {
                  v.show(() => e(p.DialogSettings, {}));
                });
              }
            })), s;
          }
        });
      }
    })), o;
  })(), De = () => (() => {
    var o = de();
    return r(o, e(E, {
      get children() {
        return e(f, {
          get title() {
            return t.t("settings.general.row.newInterfaceNotice.title");
          },
          get description() {
            return t.t("settings.general.row.newInterfaceNotice.description");
          },
          get children() {
            return e(q, {
              size: "small",
              variant: "ghost",
              get onClick() {
                return l.general.dismissNewInterfaceNotice;
              },
              get children() {
                return t.t("settings.general.row.newInterfaceNotice.dismiss");
              }
            });
          }
        });
      }
    })), o;
  })(), Fe = () => (() => {
    var o = de();
    return r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.row.language.title");
          },
          get description() {
            return t.t("settings.general.row.language.description");
          },
          get children() {
            return e(K, {
              "data-action": "settings-language",
              get options() {
                return x();
              },
              get current() {
                return x().find((s) => s.value === t.locale());
              },
              value: (s) => s.value,
              label: (s) => s.label,
              onSelect: (s) => s && t.setLocale(s.value),
              variant: "secondary",
              size: "small",
              triggerVariant: "settings"
            });
          }
        }), e(f, {
          get title() {
            return t.t("command.permissions.autoaccept.enable");
          },
          get description() {
            return t.t("toast.permissions.autoaccept.on.description");
          },
          get children() {
            var s = St();
            return r(s, e($, {
              get checked() {
                return P();
              },
              get disabled() {
                return !k();
              },
              onChange: T
            })), s;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.shell.title");
          },
          get description() {
            return t.t("settings.general.row.shell.description");
          },
          get children() {
            return e(K, {
              "data-action": "settings-shell",
              get options() {
                return Z();
              },
              get current() {
                return Z().find((s) => s.value === R()) ?? L;
              },
              value: (s) => s.id,
              label: (s) => s.label,
              onSelect: (s) => {
                s && s.value !== R() && F().updateConfig({
                  shell: s.value
                });
              },
              variant: "secondary",
              size: "small",
              triggerVariant: "settings",
              triggerStyle: {
                "min-width": "180px"
              }
            });
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.reasoningSummaries.title");
          },
          get description() {
            return t.t("settings.general.row.reasoningSummaries.description");
          },
          get children() {
            var s = kt();
            return r(s, e($, {
              get checked() {
                return l.general.showReasoningSummaries();
              },
              onChange: (n) => l.general.setShowReasoningSummaries(n)
            })), s;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.shellToolPartsExpanded.title");
          },
          get description() {
            return t.t("settings.general.row.shellToolPartsExpanded.description");
          },
          get children() {
            var s = Pt();
            return r(s, e($, {
              get checked() {
                return l.general.shellToolPartsExpanded();
              },
              onChange: (n) => l.general.setShellToolPartsExpanded(n)
            })), s;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.editToolPartsExpanded.title");
          },
          get description() {
            return t.t("settings.general.row.editToolPartsExpanded.description");
          },
          get children() {
            var s = Tt();
            return r(s, e($, {
              get checked() {
                return l.general.editToolPartsExpanded();
              },
              onChange: (n) => l.general.setEditToolPartsExpanded(n)
            })), s;
          }
        })];
      }
    })), o;
  })(), Ie = () => (() => {
    var o = H(), s = o.firstChild;
    return r(s, () => t.t("settings.general.section.advanced")), r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.row.showFileTree.title");
          },
          get description() {
            return t.t("settings.general.row.showFileTree.description");
          },
          get children() {
            var n = Dt();
            return r(n, e($, {
              get checked() {
                return l.general.showFileTree();
              },
              onChange: (p) => l.general.setShowFileTree(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.showNavigation.title");
          },
          get description() {
            return t.t("settings.general.row.showNavigation.description");
          },
          get children() {
            var n = Ft();
            return r(n, e($, {
              get checked() {
                return l.general.showNavigation();
              },
              onChange: (p) => l.general.setShowNavigation(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.showSearch.title");
          },
          get description() {
            return t.t("settings.general.row.showSearch.description");
          },
          get children() {
            var n = It();
            return r(n, e($, {
              get checked() {
                return l.general.showSearch();
              },
              onChange: (p) => l.general.setShowSearch(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.showStatus.title");
          },
          get description() {
            return t.t("settings.general.row.showStatus.description");
          },
          get children() {
            var n = zt();
            return r(n, e($, {
              get checked() {
                return l.general.showStatus();
              },
              onChange: (p) => l.general.setShowStatus(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.showCustomAgents.title");
          },
          get description() {
            return t.t("settings.general.row.showCustomAgents.description");
          },
          get children() {
            var n = Et();
            return r(n, e($, {
              get checked() {
                return l.general.showCustomAgents();
              },
              onChange: (p) => l.general.setShowCustomAgents(p)
            })), n;
          }
        })];
      }
    }), null), o;
  })(), ze = () => (() => {
    var o = H(), s = o.firstChild;
    return r(s, () => t.t("settings.general.section.appearance")), r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.row.colorScheme.title");
          },
          get description() {
            return t.t("settings.general.row.colorScheme.description");
          },
          get children() {
            return e(K, {
              "data-action": "settings-color-scheme",
              get options() {
                return ee();
              },
              get current() {
                return ee().find((n) => n.value === i.colorScheme());
              },
              value: (n) => n.value,
              label: (n) => n.label,
              onSelect: (n) => n && i.setColorScheme(n.value),
              variant: "secondary",
              size: "small",
              triggerVariant: "settings",
              triggerStyle: {
                "min-width": "220px"
              }
            });
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.theme.title");
          },
          get description() {
            return [W(() => t.t("settings.general.row.theme.description")), " ", e(bt, {
              href: "https://opencode.ai/docs/themes/",
              get children() {
                return t.t("common.learnMore");
              }
            })];
          },
          get children() {
            return e(K, {
              "data-action": "settings-theme",
              get options() {
                return N();
              },
              get current() {
                return N().find((n) => n.id === i.themeId());
              },
              value: (n) => n.id,
              label: (n) => n.name,
              onSelect: (n) => {
                n && i.setTheme(n.id);
              },
              variant: "secondary",
              size: "small",
              triggerVariant: "settings"
            });
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.uiFont.title");
          },
          get description() {
            return t.t("settings.general.row.uiFont.description");
          },
          get children() {
            var n = ue();
            return r(n, e(se, {
              "data-action": "settings-ui-font",
              get label() {
                return t.t("settings.general.row.uiFont.title");
              },
              hideLabel: !0,
              type: "text",
              get value() {
                return V();
              },
              onChange: (p) => l.appearance.setUIFont(p),
              placeholder: Ke,
              spellcheck: !1,
              autocorrect: "off",
              autocomplete: "off",
              autocapitalize: "off",
              class: "text-12-regular",
              get style() {
                return {
                  "font-family": Ge(l.appearance.uiFont())
                };
              }
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.font.title");
          },
          get description() {
            return t.t("settings.general.row.font.description");
          },
          get children() {
            var n = ue();
            return r(n, e(se, {
              "data-action": "settings-code-font",
              get label() {
                return t.t("settings.general.row.font.title");
              },
              hideLabel: !0,
              type: "text",
              get value() {
                return I();
              },
              onChange: (p) => l.appearance.setFont(p),
              placeholder: qe,
              spellcheck: !1,
              autocorrect: "off",
              autocomplete: "off",
              autocapitalize: "off",
              class: "text-12-regular",
              get style() {
                return {
                  "font-family": Ue(l.appearance.font())
                };
              }
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.row.terminalFont.title");
          },
          get description() {
            return t.t("settings.general.row.terminalFont.description");
          },
          get children() {
            var n = ue();
            return r(n, e(se, {
              "data-action": "settings-terminal-font",
              get label() {
                return t.t("settings.general.row.terminalFont.title");
              },
              hideLabel: !0,
              type: "text",
              get value() {
                return oe();
              },
              onChange: (p) => l.appearance.setTerminalFont(p),
              placeholder: Qe,
              spellcheck: !1,
              autocorrect: "off",
              autocomplete: "off",
              autocapitalize: "off",
              class: "text-12-regular",
              get style() {
                return {
                  "font-family": He(l.appearance.terminalFont())
                };
              }
            })), n;
          }
        })];
      }
    }), null), o;
  })(), Ee = () => (() => {
    var o = H(), s = o.firstChild;
    return r(s, () => t.t("settings.general.section.notifications")), r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.notifications.agent.title");
          },
          get description() {
            return t.t("settings.general.notifications.agent.description");
          },
          get children() {
            var n = At();
            return r(n, e($, {
              get checked() {
                return l.notifications.agent();
              },
              onChange: (p) => l.notifications.setAgent(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.notifications.permissions.title");
          },
          get description() {
            return t.t("settings.general.notifications.permissions.description");
          },
          get children() {
            var n = Nt();
            return r(n, e($, {
              get checked() {
                return l.notifications.permissions();
              },
              onChange: (p) => l.notifications.setPermissions(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.notifications.errors.title");
          },
          get description() {
            return t.t("settings.general.notifications.errors.description");
          },
          get children() {
            var n = Bt();
            return r(n, e($, {
              get checked() {
                return l.notifications.errors();
              },
              onChange: (p) => l.notifications.setErrors(p)
            })), n;
          }
        })];
      }
    }), null), o;
  })(), Ae = () => (() => {
    var o = H(), s = o.firstChild;
    return r(s, () => t.t("settings.general.section.sounds")), r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.sounds.agent.title");
          },
          get description() {
            return t.t("settings.general.sounds.agent.description");
          },
          get children() {
            return e(K, ge({
              "data-action": "settings-sounds-agent"
            }, () => Q(() => l.sounds.agentEnabled(), () => l.sounds.agent(), (n) => l.sounds.setAgentEnabled(n), (n) => l.sounds.setAgent(n))));
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.sounds.permissions.title");
          },
          get description() {
            return t.t("settings.general.sounds.permissions.description");
          },
          get children() {
            return e(K, ge({
              "data-action": "settings-sounds-permissions"
            }, () => Q(() => l.sounds.permissionsEnabled(), () => l.sounds.permissions(), (n) => l.sounds.setPermissionsEnabled(n), (n) => l.sounds.setPermissions(n))));
          }
        }), e(f, {
          get title() {
            return t.t("settings.general.sounds.errors.title");
          },
          get description() {
            return t.t("settings.general.sounds.errors.description");
          },
          get children() {
            return e(K, ge({
              "data-action": "settings-sounds-errors"
            }, () => Q(() => l.sounds.errorsEnabled(), () => l.sounds.errors(), (n) => l.sounds.setErrorsEnabled(n), (n) => l.sounds.setErrors(n))));
          }
        })];
      }
    }), null), o;
  })(), Ne = () => (() => {
    var o = H(), s = o.firstChild;
    return r(s, () => t.t("settings.general.section.updates")), r(o, e(E, {
      get children() {
        return [e(f, {
          get title() {
            return t.t("settings.general.row.releaseNotes.title");
          },
          get description() {
            return t.t("settings.general.row.releaseNotes.description");
          },
          get children() {
            var n = Lt();
            return r(n, e($, {
              get checked() {
                return l.general.releaseNotes();
              },
              onChange: (p) => l.general.setReleaseNotes(p)
            })), n;
          }
        }), e(f, {
          get title() {
            return t.t("settings.updates.row.check.title");
          },
          get description() {
            return t.t("settings.updates.row.check.description");
          },
          get children() {
            return e(q, {
              size: "small",
              variant: "secondary",
              get disabled() {
                return !_.action().run;
              },
              get onClick() {
                return _.run;
              },
              get children() {
                return t.t(_.action().label);
              }
            });
          }
        })];
      }
    }), null), o;
  })(), Be = () => e(w, {
    get when() {
      return A();
    },
    get children() {
      var o = H(), s = o.firstChild;
      return r(s, () => t.t("settings.general.section.display")), r(o, e(E, {
        get children() {
          return [e(f, {
            get title() {
              return t.t("settings.general.row.pinchZoom.title");
            },
            get description() {
              return t.t("settings.general.row.pinchZoom.description");
            },
            get children() {
              var n = Ot();
              return r(n, e($, {
                get checked() {
                  return u.latest;
                },
                onChange: X
              })), n;
            }
          }), e(w, {
            get when() {
              return y();
            },
            get children() {
              return e(f, {
                get title() {
                  return (() => {
                    var n = Mt(), p = n.firstChild;
                    return r(p, () => t.t("settings.general.row.wayland.title")), r(n, e(We, {
                      get value() {
                        return t.t("settings.general.row.wayland.tooltip");
                      },
                      placement: "top",
                      get children() {
                        var g = jt();
                        return r(g, e(j, {
                          name: "help",
                          size: "small"
                        })), g;
                      }
                    }), null), n;
                  })();
                },
                get description() {
                  return t.t("settings.general.row.wayland.description");
                },
                get children() {
                  var n = Vt();
                  return r(n, e($, {
                    get checked() {
                      return U.latest === "wayland";
                    },
                    onChange: ae
                  })), n;
                }
              });
            }
          })];
        }
      }), null), o;
    }
  });
  return (() => {
    var o = Rt(), s = o.firstChild, n = s.firstChild, p = n.firstChild, g = s.nextSibling;
    return r(p, () => t.t("settings.tab.general")), r(g, e(w, {
      get when() {
        return l.general.layoutTransitionAvailable();
      },
      get children() {
        return e(Te, {});
      }
    }), null), r(g, e(w, {
      get when() {
        return l.general.newInterfaceNoticeVisible();
      },
      get children() {
        return e(De, {});
      }
    }), null), r(g, e(Fe, {}), null), r(g, e(ze, {}), null), r(g, e(Ee, {}), null), r(g, e(Ae, {}), null), r(g, e(Ne, {}), null), r(g, e(Be, {}), null), r(g, e(w, {
      get when() {
        return A();
      },
      get children() {
        return e(Ie, {});
      }
    }), null), o;
  })();
}, f = (i) => (() => {
  var t = Zt(), a = t.firstChild, c = a.firstChild, v = c.nextSibling, m = a.nextSibling;
  return r(c, () => i.title), r(v, () => i.description), r(m, () => i.children), t;
})();
function Se(i) {
  const t = me(), a = he();
  return e(w, {
    get when() {
      return a.general.newLayoutDesigns();
    },
    get fallback() {
      return i.children;
    },
    get children() {
      return e(w, {
        get when() {
          return t.settings.server.selected();
        },
        children: (c) => e(Gt, {
          get server() {
            return c();
          },
          get children() {
            return i.children;
          }
        })
      });
    }
  });
}
function Gt(i) {
  const t = me(), a = () => t.ensureServerCtx(i.server);
  return e(it, {
    get client() {
      return a().queryClient;
    },
    get children() {
      return e(rt, {
        server: () => i.server,
        get children() {
          return e(nt, {
            get children() {
              return e(st, {
                get children() {
                  return i.children;
                }
              });
            }
          });
        }
      });
    }
  });
}
function ke() {
  const i = me(), t = he(), a = z(() => t.general.newLayoutDesigns() ? i.settings.server.selected() : void 0);
  return e(w, {
    get when() {
      return a();
    },
    children: (c) => e(G, {
      gutter: 4,
      placement: "bottom-end",
      get children() {
        return [e(G.Trigger, {
          as: q,
          variant: "secondary",
          size: "large",
          class: "h-8 max-w-[260px] gap-2 px-2 py-1.5 data-[expanded]:bg-surface-base-active",
          get children() {
            return [e(xe, {
              get health() {
                return i.servers.health[te.key(c())];
              }
            }), e(be, {
              get conn() {
                return c();
              },
              get status() {
                return i.servers.health[te.key(c())];
              },
              class: "flex items-center gap-2 min-w-0 flex-1",
              nameClass: "text-14-regular text-text-base truncate",
              versionClass: "hidden"
            }), e(j, {
              name: "chevron-down",
              size: "small",
              class: "text-icon-weak shrink-0"
            })];
          }
        }), e(G.Portal, {
          get children() {
            return e(G.Content, {
              class: "w-[320px] mt-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-2 [&_[data-slot=dropdown-menu-radio-item]]:pr-2",
              get children() {
                return e(G.RadioGroup, {
                  get value() {
                    return i.settings.server.key;
                  },
                  onChange: (v) => {
                    typeof v == "string" && i.settings.server.set(te.Key.make(v));
                  },
                  get children() {
                    return e(Y, {
                      get each() {
                        return i.servers.list();
                      },
                      children: (v) => {
                        const m = te.key(v), l = () => i.servers.health[m]?.healthy === !1;
                        return e(G.RadioItem, {
                          value: m,
                          get disabled() {
                            return l();
                          },
                          get children() {
                            return [e(xe, {
                              get health() {
                                return i.servers.health[m];
                              }
                            }), e(be, {
                              conn: v,
                              get dimmed() {
                                return l();
                              },
                              get status() {
                                return i.servers.health[m];
                              },
                              class: "flex items-center gap-2 min-w-0 flex-1",
                              nameClass: "text-14-regular text-text-base truncate",
                              versionClass: "text-12-regular text-text-weak truncate"
                            }), e(G.ItemIndicator, {
                              get children() {
                                return e(j, {
                                  name: "check-small",
                                  size: "small",
                                  class: "text-icon-weak"
                                });
                              }
                            })];
                          }
                        });
                      }
                    });
                  }
                });
              }
            });
          }
        })];
      }
    })
  });
}
var qt = /* @__PURE__ */ d('<div class="flex items-center justify-between gap-4 min-h-16 border-b border-border-weak-base last:border-none flex-wrap py-3"data-component=custom-provider-section><div class="flex flex-col min-w-0"><div class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class="text-14-medium text-text-strong"></span></div><span class="text-12-regular text-text-weak pl-8">'), Ut = /* @__PURE__ */ d('<div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10"><div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]"><div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]"><h2 class="text-16-medium text-text-strong"></h2></div></div><div class="flex flex-col gap-8 max-w-[720px]"><div class="flex flex-col gap-1"data-component=connected-providers-section><h3 class="text-14-medium text-text-strong pb-2"></h3></div><div class="flex flex-col gap-1"><h3 class="text-14-medium text-text-strong pb-2">'), Qt = /* @__PURE__ */ d('<div class="py-4 text-14-regular text-text-weak">'), Ht = /* @__PURE__ */ d('<div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none"><div class="flex items-center gap-3 min-w-0"><span class="text-14-medium text-text-strong truncate">'), Wt = /* @__PURE__ */ d('<span class="text-14-regular text-text-base opacity-0 group-hover:opacity-100 transition-opacity duration-200 pr-3 cursor-default">'), Xt = /* @__PURE__ */ d('<div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none"><div class="flex flex-col min-w-0"><div class="flex items-center gap-x-3"><span class="text-14-medium text-text-strong">'), Yt = /* @__PURE__ */ d('<span class="text-12-regular text-text-weak pl-8">');
const Jt = [{
  match: (i) => i === "opencode",
  key: "dialog.provider.opencode.note"
}, {
  match: (i) => i === "opencode-go",
  key: "dialog.provider.opencodeGo.tagline"
}, {
  match: (i) => i === "anthropic",
  key: "dialog.provider.anthropic.note"
}, {
  match: (i) => i.startsWith("github-copilot"),
  key: "dialog.provider.copilot.note"
}, {
  match: (i) => i === "openai",
  key: "dialog.provider.openai.note"
}, {
  match: (i) => i === "google",
  key: "dialog.provider.google.note"
}, {
  match: (i) => i === "openrouter",
  key: "dialog.provider.openrouter.note"
}, {
  match: (i) => i === "vercel",
  key: "dialog.provider.vercel.note"
}], er = (i) => e(Se, {
  get children() {
    return e(tr, {
      get onBack() {
        return i.onBack;
      }
    });
  }
}), tr = (i) => {
  const t = pe(), a = J(), c = ye(), v = lt(), m = $e(), l = at(() => {
  }), _ = wt({
    onBack: i.onBack
  }), y = (h) => {
    _.select(h), t.show(() => e($t, {
      controller: _
    }));
  }, k = z(() => l.connected().filter((h) => h.id !== "opencode" || Object.values(h.models).find((u) => u.cost?.input))), P = z(() => {
    const h = new Set(k().map((b) => b.id)), u = l.popular().filter((b) => !h.has(b.id)).slice();
    return u.sort((b, L) => le.indexOf(b.id) - le.indexOf(L.id)), u;
  }), T = (h) => {
    if (!("source" in h)) return;
    const u = h.source;
    if (u === "env" || u === "api" || u === "config" || u === "custom") return u;
  }, A = (h) => {
    const u = T(h);
    return u === "env" ? a.t("settings.providers.tag.environment") : u === "api" ? a.t("provider.connect.method.apiKey") : u === "config" ? B(h.id) ? a.t("settings.providers.tag.custom") : a.t("settings.providers.tag.config") : u === "custom" ? a.t("settings.providers.tag.custom") : a.t("settings.providers.tag.other");
  }, N = (h) => T(h) !== "env" && (v() === "v1" || !B(h.id)), F = (h) => Jt.find((u) => u.match(h))?.key, B = (h) => {
    const u = m().data.config.provider?.[h];
    return !(!u || u.npm !== "@ai-sdk/openai-compatible" || !u.models || Object.keys(u.models).length === 0);
  }, O = async (h, u) => {
    if (v() !== "v1") return;
    const b = m().data.config.disabled_providers ?? [], L = b.includes(h) ? b : [...b, h];
    m().set("config", "disabled_providers", L), await m().updateConfig({
      disabled_providers: L
    }).then(() => {
      ne({
        variant: "success",
        icon: "circle-check",
        title: a.t("provider.disconnect.toast.disconnected.title", {
          provider: u
        }),
        description: a.t("provider.disconnect.toast.disconnected.description", {
          provider: u
        })
      });
    }).catch((R) => {
      m().set("config", "disabled_providers", b);
      const Z = R instanceof Error ? R.message : String(R);
      ne({
        title: a.t("common.requestFailed"),
        description: Z
      });
    });
  }, U = async (h, u) => {
    if (B(h)) {
      await c().client.auth.remove({
        providerID: h
      }).catch(() => {
      }), await O(h, u);
      return;
    }
    await c().client.auth.remove({
      providerID: h
    }).then(async () => {
      await c().client.global.dispose(), ne({
        variant: "success",
        icon: "circle-check",
        title: a.t("provider.disconnect.toast.disconnected.title", {
          provider: u
        }),
        description: a.t("provider.disconnect.toast.disconnected.description", {
          provider: u
        })
      });
    }).catch((b) => {
      const L = b instanceof Error ? b.message : String(b);
      ne({
        title: a.t("common.requestFailed"),
        description: L
      });
    });
  };
  return (() => {
    var h = Ut(), u = h.firstChild, b = u.firstChild, L = b.firstChild, R = u.nextSibling, Z = R.firstChild, ae = Z.firstChild, X = Z.nextSibling, ee = X.firstChild;
    return r(L, () => a.t("settings.providers.title")), r(b, e(ke, {}), null), r(ae, () => a.t("settings.providers.section.connected")), r(Z, e(E, {
      get children() {
        return e(w, {
          get when() {
            return k().length > 0;
          },
          get fallback() {
            return (() => {
              var x = Qt();
              return r(x, () => a.t("settings.providers.connected.empty")), x;
            })();
          },
          get children() {
            return e(Y, {
              get each() {
                return k();
              },
              children: (x) => (() => {
                var D = Ht(), C = D.firstChild, I = C.firstChild;
                return r(C, e(ie, {
                  get id() {
                    return x.id;
                  },
                  class: "size-5 shrink-0 icon-strong-base"
                }), I), r(I, () => x.name), r(C, e(re, {
                  get children() {
                    return A(x);
                  }
                }), null), r(D, e(w, {
                  get when() {
                    return N(x);
                  },
                  get fallback() {
                    return (() => {
                      var V = Wt();
                      return r(V, () => a.t("settings.providers.connected.environmentDescription")), V;
                    })();
                  },
                  get children() {
                    return e(q, {
                      size: "large",
                      variant: "ghost",
                      onClick: () => void U(x.id, x.name),
                      get children() {
                        return a.t("common.disconnect");
                      }
                    });
                  }
                }), null), D;
              })()
            });
          }
        });
      }
    }), null), r(ee, () => a.t("settings.providers.section.popular")), r(X, e(E, {
      get children() {
        return [e(Y, {
          get each() {
            return P();
          },
          children: (x) => (() => {
            var D = Xt(), C = D.firstChild, I = C.firstChild, V = I.firstChild;
            return r(I, e(ie, {
              get id() {
                return x.id;
              },
              class: "size-5 shrink-0 icon-strong-base"
            }), V), r(V, () => x.name), r(I, e(w, {
              get when() {
                return x.id === "opencode";
              },
              get children() {
                return e(re, {
                  get children() {
                    return a.t("dialog.provider.tag.recommended");
                  }
                });
              }
            }), null), r(I, e(w, {
              get when() {
                return x.id === "opencode-go";
              },
              get children() {
                return e(re, {
                  get children() {
                    return a.t("dialog.provider.tag.recommended");
                  }
                });
              }
            }), null), r(C, e(w, {
              get when() {
                return F(x.id);
              },
              children: (oe) => (() => {
                var Q = Yt();
                return r(Q, () => a.t(oe())), Q;
              })()
            }), null), r(D, e(q, {
              size: "large",
              variant: "secondary",
              icon: "plus-small",
              onClick: () => y(x.id),
              get children() {
                return a.t("common.connect");
              }
            }), null), D;
          })()
        }), e(w, {
          get when() {
            return v() === "v1";
          },
          get children() {
            var x = qt(), D = x.firstChild, C = D.firstChild, I = C.firstChild, V = C.nextSibling;
            return r(C, e(ie, {
              id: "synthetic",
              class: "size-5 shrink-0 icon-strong-base"
            }), I), r(I, () => a.t("provider.custom.title")), r(C, e(re, {
              get children() {
                return a.t("settings.providers.tag.custom");
              }
            }), null), r(V, () => a.t("settings.providers.custom.description")), r(x, e(q, {
              size: "large",
              variant: "secondary",
              icon: "plus-small",
              onClick: () => {
                t.show(() => e(_t, {
                  get onBack() {
                    return t.close;
                  }
                }));
              },
              get children() {
                return a.t("common.connect");
              }
            }), null), x;
          }
        })];
      }
    }), null), r(X, e(q, {
      variant: "ghost",
      class: "px-0 py-0 mt-5 text-14-medium text-text-interactive-base text-left justify-start hover:bg-transparent active:bg-transparent",
      onClick: () => y(),
      get children() {
        return a.t("dialog.provider.viewAll");
      }
    }), null), h;
  })();
};
var Pe = /* @__PURE__ */ d('<div class="flex flex-col items-center justify-center py-12 text-center"><span class="text-14-regular text-text-weak">'), rr = /* @__PURE__ */ d('<span class="text-14-regular text-text-strong mt-1">&quot;<!>&quot;'), nr = /* @__PURE__ */ d('<div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10"><div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]"><div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]"><div class="flex items-center justify-between gap-4"><h2 class="text-16-medium text-text-strong"></h2></div><div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base"></div></div></div><div class="flex flex-col gap-8 max-w-[720px]">'), sr = /* @__PURE__ */ d('<div class="flex flex-col gap-1"><div class="flex items-center gap-2 pb-2"><span class="text-14-medium text-text-strong">'), ir = /* @__PURE__ */ d('<div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none"><div class=min-w-0><span class="text-14-regular text-text-strong truncate block"></span></div><div class=flex-shrink-0>');
const lr = (i) => (() => {
  var t = Pe(), a = t.firstChild;
  return r(a, () => i.label), t;
})(), ar = (i) => (() => {
  var t = Pe(), a = t.firstChild;
  return r(a, () => i.message), r(t, e(w, {
    get when() {
      return i.filter;
    },
    get children() {
      var c = rr(), v = c.firstChild, m = v.nextSibling;
      return m.nextSibling, r(c, () => i.filter, m), c;
    }
  }), null), t;
})(), or = () => e(Se, {
  get children() {
    return e(cr, {});
  }
}), cr = () => {
  const i = J(), t = ot(), a = ct({
    items: (c) => t.list(),
    key: (c) => `${c.provider.id}:${c.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (c, v) => c.name.localeCompare(v.name),
    groupBy: (c) => c.provider.id,
    sortGroupsBy: (c, v) => {
      const m = le.indexOf(c.category), l = le.indexOf(v.category), _ = m >= 0, y = l >= 0;
      if (_ && !y) return -1;
      if (!_ && y) return 1;
      if (_ && y) return m - l;
      const k = c.items[0].provider.name, P = v.items[0].provider.name;
      return k.localeCompare(P);
    }
  });
  return (() => {
    var c = nr(), v = c.firstChild, m = v.firstChild, l = m.firstChild, _ = l.firstChild, y = l.nextSibling, k = v.nextSibling;
    return r(_, () => i.t("settings.models.title")), r(l, e(ke, {}), null), r(y, e(j, {
      name: "magnifying-glass",
      class: "text-icon-weak-base flex-shrink-0"
    }), null), r(y, e(se, {
      variant: "ghost",
      type: "text",
      get value() {
        return a.filter();
      },
      get onChange() {
        return a.onInput;
      },
      get placeholder() {
        return i.t("dialog.model.search.placeholder");
      },
      spellcheck: !1,
      autocorrect: "off",
      autocomplete: "off",
      autocapitalize: "off",
      class: "flex-1"
    }), null), r(y, e(w, {
      get when() {
        return a.filter();
      },
      get children() {
        return e(gt, {
          icon: "circle-x",
          variant: "ghost",
          get onClick() {
            return a.clear;
          }
        });
      }
    }), null), r(k, e(w, {
      get when() {
        return !a.grouped.loading;
      },
      get fallback() {
        return e(lr, {
          get label() {
            return `${i.t("common.loading")}${i.t("common.loading.ellipsis")}`;
          }
        });
      },
      get children() {
        return e(w, {
          get when() {
            return a.flat().length > 0;
          },
          get fallback() {
            return e(ar, {
              get message() {
                return i.t("dialog.model.empty");
              },
              get filter() {
                return a.filter();
              }
            });
          },
          get children() {
            return e(Y, {
              get each() {
                return a.grouped.latest;
              },
              children: (P) => (() => {
                var T = sr(), A = T.firstChild, N = A.firstChild;
                return r(A, e(ie, {
                  get id() {
                    return P.category;
                  },
                  class: "size-5 shrink-0 icon-strong-base"
                }), N), r(N, () => P.items[0].provider.name), r(T, e(E, {
                  get children() {
                    return e(Y, {
                      get each() {
                        return P.items;
                      },
                      children: (F) => {
                        const B = {
                          providerID: F.provider.id,
                          modelID: F.id
                        };
                        return (() => {
                          var O = ir(), U = O.firstChild, h = U.firstChild, u = U.nextSibling;
                          return r(h, () => F.name), r(u, e($, {
                            get checked() {
                              return t.visible(B);
                            },
                            onChange: (b) => {
                              t.setVisibility(B, b);
                            },
                            hideLabel: !0,
                            get children() {
                              return F.name;
                            }
                          })), O;
                        })();
                      }
                    });
                  }
                }), null), T;
              })()
            });
          }
        });
      }
    })), c;
  })();
};
var gr = /* @__PURE__ */ d('<div class="flex flex-1 min-h-0 flex-col gap-4 pt-6"><div class="text-16-medium text-text-strong">'), dr = /* @__PURE__ */ d('<div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10"><div class="flex flex-col flex-1 min-h-0 max-w-[720px]">'), ur = /* @__PURE__ */ d('<div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]"><div class="flex flex-col gap-1 pt-6 pb-8"><h2 class="text-16-medium text-text-strong">');
const pr = () => {
  const i = J(), t = dt();
  return (() => {
    var a = dr(), c = a.firstChild;
    return r(c, e(w, {
      get when() {
        return t.isFormMode();
      },
      get fallback() {
        return [(() => {
          var v = ur(), m = v.firstChild, l = m.firstChild;
          return r(l, () => i.t("status.popover.tab.servers")), v;
        })(), e(pt, {
          controller: t
        })];
      },
      get children() {
        var v = gr(), m = v.firstChild;
        return r(m, () => t.formTitle()), r(v, e(ut, {
          controller: t
        }), null), v;
      }
    })), a;
  })();
};
var hr = /* @__PURE__ */ d('<div class="flex flex-col justify-between h-full w-full gap-4"><div class="flex flex-col gap-3 w-full pt-3"><div class="flex flex-col gap-3"><div class="flex flex-col gap-1.5"><div class="flex flex-col gap-1.5 w-full"></div></div><div class="flex flex-col gap-1.5"><div class="flex flex-col gap-1.5 w-full"></div></div></div></div><div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak"><span></span><span class=text-11-regular>v');
const mr = (i) => {
  const t = J(), a = _e(), c = pe(), [v, m] = ht(i.defaultValue ?? "general"), l = () => {
    c.show(() => e(mr, {
      defaultValue: "providers"
    }));
  };
  return e(vt, {
    size: "x-large",
    transition: !0,
    get children() {
      return e(S, {
        orientation: "vertical",
        variant: "settings",
        get value() {
          return v();
        },
        onChange: (_) => void mt(() => m(_)),
        class: "h-full settings-dialog",
        get children() {
          return [e(S.List, {
            get children() {
              var _ = hr(), y = _.firstChild, k = y.firstChild, P = k.firstChild, T = P.firstChild, A = P.nextSibling, N = A.firstChild, F = y.nextSibling, B = F.firstChild, O = B.nextSibling;
              return O.firstChild, r(P, e(S.SectionTitle, {
                get children() {
                  return t.t("settings.section.desktop");
                }
              }), T), r(T, e(S.Trigger, {
                value: "general",
                get children() {
                  return [e(j, {
                    name: "sliders"
                  }), W(() => t.t("settings.tab.general"))];
                }
              }), null), r(T, e(S.Trigger, {
                value: "shortcuts",
                get children() {
                  return [e(j, {
                    name: "keyboard"
                  }), W(() => t.t("settings.tab.shortcuts"))];
                }
              }), null), r(T, e(S.Trigger, {
                value: "servers",
                get children() {
                  return [e(j, {
                    name: "server"
                  }), W(() => t.t("status.popover.tab.servers"))];
                }
              }), null), r(A, e(S.SectionTitle, {
                get children() {
                  return t.t("settings.section.server");
                }
              }), N), r(N, e(S.Trigger, {
                value: "providers",
                get children() {
                  return [e(j, {
                    name: "providers"
                  }), W(() => t.t("settings.providers.title"))];
                }
              }), null), r(N, e(S.Trigger, {
                value: "models",
                get children() {
                  return [e(j, {
                    name: "models"
                  }), W(() => t.t("settings.models.title"))];
                }
              }), null), r(B, () => t.t("app.name.desktop")), r(O, () => a.version, null), _;
            }
          }), e(S.Content, {
            value: "general",
            class: "no-scrollbar",
            get children() {
              return e(Kt, {});
            }
          }), e(S.Content, {
            value: "shortcuts",
            class: "no-scrollbar",
            get children() {
              return e(xt, {});
            }
          }), e(S.Content, {
            value: "servers",
            class: "no-scrollbar",
            get children() {
              return e(pr, {});
            }
          }), e(S.Content, {
            value: "providers",
            class: "no-scrollbar",
            get children() {
              return e(er, {
                onBack: l
              });
            }
          }), e(S.Content, {
            value: "models",
            class: "no-scrollbar",
            get children() {
              return e(or, {});
            }
          })];
        }
      });
    }
  });
};
export {
  mr as DialogSettings
};
